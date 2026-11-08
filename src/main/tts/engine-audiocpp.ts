/**
 * audio.cpp E2E TTS 引擎（进程内 FFI，描述符驱动）
 *
 * 架构：worker 子进程里 `audiocpp.dll` 直接合成，不再有 CLI 子进程与临时 wav。
 *
 * 职责边界（低耦合）：
 * - 模型族收敛在 `ModelSpec` 描述符（spec-data.ts 的 `backend.family`）；
 * - 进程/协议在 `inference/audiocpp-ffi/host.ts`；
 * - 推理本身在 worker 的 `session-tts.ts`。
 */

import { basename, dirname } from 'node:path'
import { findSpec } from '../models/model-manager'
import type { ModelSpec } from '../models/spec-data'
import { AudiocppTtsHost } from '../inference/audiocpp-ffi/host'
import { audiocppRuntimeForDevice } from '../inference/runtime-download'
import { getGpuInfo } from '../inference/vram'
import { log } from '../core/logger'
import type { SynthAudio, TtsEngine } from './traits'

/** 引擎可变状态 */
interface AudiocppInner {
  /** 当前模型描述符（null = 未加载） */
  spec: ModelSpec | null
  /** 模型族名（audiocpp 的 family，如 "moss_tts_nano"） */
  family: string
  /** 后端（"cpu" / "cuda"） */
  backend: string
  /** 推理线程数 */
  numThreads: number
  /** 当前语言（空 = 自动） */
  language: string
}

/** 合成语速倍率（与其它引擎一致：固定 1.0） */
const SYNTH_SPEED = 1

/**
 * 从模型文件路径解析描述符。
 *
 * audio.cpp 的权重常放在 `<模型目录>/<族>-GGUF/<file>.gguf`（HF 仓库结构），
 * 所以要从文件所在目录往上找到描述符目录（最多 3 层），文件名只作最后兜底。
 */
function resolveSpec(modelPath: string): ModelSpec | undefined {
  let dir = dirname(modelPath)
  for (let i = 0; i < 3; i++) {
    const name = basename(dir)
    if (name) {
      const spec = findSpec(name)
      if (spec) return spec
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const file = basename(modelPath)
  return file ? findSpec(file) : undefined
}

/** 设备名 → audio.cpp 后端名 */
function backendFor(device: string): string {
  const d = device.trim().toLowerCase()
  if (d === 'cuda' || d === 'gpu') return 'cuda'
  if (d === 'vulkan') return 'vulkan'
  return 'cpu'
}

/** audio.cpp E2E TTS 引擎（进程内 FFI） */
export class AudiocppTtsEngine implements TtsEngine {
  private inner: AudiocppInner
  private readonly host: AudiocppTtsHost

  constructor(host: AudiocppTtsHost = new AudiocppTtsHost()) {
    this.host = host
    this.inner = {
      spec: null,
      family: '',
      backend: 'cpu',
      numThreads: 4,
      language: ''
    }
  }

  // ── TtsEngine 实现 ────────────────────────────────────────────────────────

  name(): string {
    return this.inner.spec?.id ?? ''
  }

  async load(modelPath: string, device: string): Promise<void> {
    const spec = resolveSpec(modelPath)
    if (!spec) throw new Error(`无法识别 TTS 模型: ${modelPath}`)
    if (spec.backend.type !== 'audiocpp') {
      throw new Error(`${spec.name} 不是 audio.cpp 模型`)
    }

    // 选变体目录：cuda 需要 CUDA 包（含 ggml-cuda.dll），否则回退 CPU 包 / 报变体不匹配
    const gpu = await getGpuInfo()
    const choice = audiocppRuntimeForDevice(device, gpu.available)
    const runtimeDir = choice.dir
    if (choice.backend === 'cpu' && backendFor(device) === 'cuda') {
      log.info(
        `[audiocpp-tts] ${gpu.available ? 'CUDA 变体未安装' : '未检测到 NVIDIA GPU'}，回退 CPU 推理`
      )
    }

    // 候选状态先写入再校验，校验失败必须回滚：否则 isLoaded()（= spec 非空）会谎报已加载
    const prevSpec = this.inner.spec
    const prevFamily = this.inner.family
    const prevBackend = this.inner.backend
    this.inner.spec = spec
    this.inner.family = spec.backend.family
    this.inner.backend = choice.backend

    try {
      await this.host.load({
        runtimeDir,
        modelPath,
        familyHint: this.inner.family,
        backend: this.inner.backend,
        numThreads: this.inner.numThreads
      })
    } catch (e) {
      this.inner.spec = prevSpec
      this.inner.family = prevFamily
      this.inner.backend = prevBackend
      throw e
    }

    // 语言对齐：当前语言不在描述符支持列表 → 切到 "en"（有则用）否则首个支持语言
    if (this.inner.language && !spec.languages.includes(this.inner.language)) {
      const fallback = spec.languages.includes('en') ? 'en' : spec.languages[0]
      this.inner.language = fallback ?? ''
    }
  }

  async unload(): Promise<void> {
    await this.host.unload()
    this.inner.spec = null
    this.inner.family = ''
  }

  isLoaded(): boolean {
    return this.inner.spec !== null
  }

  async setLanguage(language: string): Promise<void> {
    const spec = this.inner.spec
    if (spec && language && !spec.languages.includes(language)) {
      throw new Error(
        `模型 ${spec.name} 不支持语言 '${language}'（支持: ${spec.languages.join(', ')}）`
      )
    }
    this.inner.language = language
  }

  /** audio.cpp 的首批模型无预设音色；克隆参数暂不接线（保持接口默认拒绝） */
  async setCloneVoice(): Promise<void> {
    throw new Error('当前 audio.cpp 模型不支持语音克隆')
  }

  clearCloneVoice(): void {
    /* 无克隆状态 */
  }

  async synthesize(text: string, voice: string): Promise<SynthAudio> {
    if (!this.isLoaded()) throw new Error('TTS 模型未加载')
    if (!text) return { samples: new Int16Array(0), sampleRate: 0 }

    const options: Record<string, string> = {}
    // 语音参数非空时透传为 voice_id（部分族支持）；空则用模型默认
    const voiceId = (voice ?? '').trim()
    if (voiceId && Number.isNaN(Number(voiceId))) options.voice_id = voiceId

    const reply = await this.host.synthesize({
      text,
      language: this.inner.language,
      options
    })
    return { samples: reply.samples, sampleRate: reply.sampleRate }
  }

  vramEstimateMb(): number | null {
    return null
  }

  /** 退出路径：同步杀掉 worker */
  killForExit(): void {
    this.host.killForExit()
  }
}

/** 合成语速（保留导出，避免将来接入时再散落魔法数） */
export const AUDIOCPP_SYNTH_SPEED = SYNTH_SPEED
