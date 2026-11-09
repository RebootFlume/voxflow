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

import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { readWav } from '../audio/wav'
import { findSpecInLayer, modelRef } from '../models/model-manager'
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
  /** 克隆参考音频（说话人参考；null = 未设置） */
  referenceAudio: {
    samples: Float32Array
    frames: number
    sampleRate: number
    channels: number
  } | null
  /** 克隆参考文本（部分模型必填） */
  referenceText: string | null
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
  const levels: string[] = []
  let dir = dirname(modelPath)
  for (let i = 0; i < 3; i++) {
    const name = basename(dir)
    if (name) levels.push(name)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // 只在**本框架层内**反查：目录名可能长得像别的族（`Qwen3-TTS-...-GGUF`），
  // 跨层/前缀兜底会猜错族（把 A 族的描述符套到 B 族权重上）。
  for (const name of levels) {
    const spec = findSpecInLayer('audio.cpp', name)
    if (spec) return spec
  }
  const file = basename(modelPath)
  return file ? findSpecInLayer('audio.cpp', file) : undefined
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
      language: '',
      referenceAudio: null,
      referenceText: null
    }
  }

  // ── TtsEngine 实现 ────────────────────────────────────────────────────────

  name(): string {
    const spec = this.inner.spec
    return spec ? modelRef(spec) : ''
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

    // 换模型必须丢掉上一份参考音频/文本：克隆参数是"给某个模型准备的说话人参考"，
    // 残留到预设音色模型上会被当成克隆请求（Qwen3 custom voice 直接报
    // "prefill requires speaker"）。就绪后的恢复路径由音色库 active_id 重新下发。
    this.inner.referenceAudio = null
    this.inner.referenceText = null

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
    this.inner.referenceAudio = null
    this.inner.referenceText = null
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

  /**
   * 设置克隆音色：读参考音频 → 交给 C 侧的说话人参考槽。
   *
   * Qwen3-TTS Base 这类模型**只有克隆**（没有预设音色），必须提供参考音频 +
   * 参考文本；缺参考音频 C 侧会直接报
   * "Qwen3 base TTS requires voice clone reference audio"。
   */
  async setCloneVoice(audio: string, text: string): Promise<void> {
    const spec = this.inner.spec
    if (!spec) throw new Error('TTS 模型未加载，无法设置克隆音色')

    const vm = spec.voiceMode
    const cloneCapable = vm.type === 'clone' || vm.type === 'presetAndClone'
    if (!cloneCapable) {
      throw new Error(`当前 TTS 模型（${spec.name}）不支持语音克隆`)
    }
    const requiresText =
      vm.type === 'clone' ? vm.requiresText : vm.type === 'presetAndClone' ? vm.clone.requiresText : false

    const trimmed = (text ?? '').trim()
    if (requiresText && !trimmed) {
      throw new Error(`模型 ${spec.name} 需要参考文本（参考音频里说的内容）`)
    }
    if (!audio || !existsSync(audio)) {
      throw new Error(`参考音频不存在: ${audio}`)
    }

    const wav = readWav(audio)
    const channels = wav.channels || 1
    const frames = Math.floor(wav.samples.length / channels)
    if (frames <= 0) throw new Error(`参考音频没有采样数据: ${audio}`)

    this.inner.referenceAudio = {
      samples: wav.samples,
      frames,
      sampleRate: wav.sampleRate,
      channels
    }
    this.inner.referenceText = trimmed ? trimmed : null
  }

  /** 清除克隆参数（回到预设音色） */
  clearCloneVoice(): void {
    this.inner.referenceAudio = null
    this.inner.referenceText = null
  }

  async synthesize(text: string, voice: string): Promise<SynthAudio> {
    if (!this.isLoaded()) throw new Error('TTS 模型未加载')
    if (!text) return { samples: new Int16Array(0), sampleRate: 0 }

    const options: Record<string, string> = {}
    // 语音参数非空时透传为 voice_id（部分族支持）；空则用模型默认
    const voiceId = (voice ?? '').trim()
    // 克隆激活时音色由参考音频决定，voice_id 不再参与
    const clone = this.inner.referenceAudio
    if (!clone && voiceId && Number.isNaN(Number(voiceId))) options.voice_id = voiceId
    // 参考文本：Qwen3-TTS 克隆需要它对齐参考音频内容
    if (clone && this.inner.referenceText) options.reference_text = this.inner.referenceText

    const reply = await this.host.synthesize({
      text,
      language: this.inner.language,
      options,
      voiceAudio: clone ?? undefined
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
