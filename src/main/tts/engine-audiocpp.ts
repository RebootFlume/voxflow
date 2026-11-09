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
import { resolveVoice, voiceListOf } from './speakers'
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
  /** 自然语言音色描述（audio.cpp 的 instruct；null = 不用） */
  instruct: string | null
  /** 当前模型目录（音色表 / voices.json 之类要按目录读） */
  modelDir: string
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
      referenceText: null,
      instruct: null,
      modelDir: ''
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

    // 单一运行时包：设备只决定传给 C 侧的后端名（包内同时含 ggml-cpu / ggml-cuda）
    const gpu = await getGpuInfo()
    const choice = audiocppRuntimeForDevice(device, gpu.available)
    const runtimeDir = choice.dir
    if (choice.backend === 'cpu' && backendFor(device) === 'cuda') {
      log.info('[audiocpp-tts] 未检测到可用的 NVIDIA GPU，回退 CPU 推理')
    }

    // 候选状态先写入再校验，校验失败必须回滚：否则 isLoaded()（= spec 非空）会谎报已加载
    const prevSpec = this.inner.spec
    const prevFamily = this.inner.family
    const prevBackend = this.inner.backend
    this.inner.spec = spec
    this.inner.family = spec.backend.family
    this.inner.backend = choice.backend
    this.inner.modelDir = dirname(modelPath)

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
    // 音色描述同理：不同模型族对 instruct 的解释不同，跨模型沿用只会得到意外音色。
    this.inner.referenceAudio = null
    this.inner.referenceText = null
    this.inner.instruct = null

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
    this.inner.modelDir = ''
    this.inner.referenceAudio = null
    this.inner.referenceText = null
    this.inner.instruct = null
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

  /**
   * 设置自然语言音色描述（audio.cpp 请求选项 `instruct`）。
   *
   * 只有描述符声明 `instruct: true` 的模型接受它；空串 = 关闭。
   */
  setInstruct(text: string): void {
    const spec = this.inner.spec
    if (!spec) throw new Error('TTS 模型未加载，无法设置音色描述')
    if (spec.instruct !== true) {
      throw new Error(`当前 TTS 模型（${spec.name}）不支持音色描述`)
    }
    const trimmed = (text ?? '').trim()
    this.inner.instruct = trimmed ? trimmed : null
    // 留痕：描述是运行态、且会显著改变输出，排查「为什么音色和预期不符」时要能对上时间点
    log.info(`[tts] 音色描述${trimmed ? `已设置：${trimmed}` : '已清空'}（${spec.name}）`)
  }

  /**
   * UI / API 传进来的音色 → C 侧的 voice_id。
   *
   * 前端对所有模型统一用 **sid（数字序号）** 标识音色，但 audio.cpp 的预设音色是
   * **名字**（qwen3_tts 的 vivian / serena…），API 调用方又习惯传名字。
   * 统一交给共享解析器（序号 / 名字都认，认不出抛错而不是静默换音色）。
   *
   * 两个 audio.cpp 专属规则：
   * - 未指定（空 / "default"）时落到**第一个**音色：有命名预设音色的族不接受缺省
   *   （Qwen3 CustomVoice 对缺 speaker 的请求直接报 "prefill requires speaker"）；
   * - 没有预设音色的族（fixed / 仅克隆）返回空串 = 不下发 voice_id。
   */
  private resolveVoiceId(voice: string): string {
    const spec = this.inner.spec
    if (!spec) return ''
    const list = voiceListOf(spec, this.inner.modelDir)
    if (!list || list.length === 0) return ''
    // 越界序号不抛错：前端所有模型共用一个 `voice` 字段，切到音色更少的模型时
    // 必然残留上一个 sid —— 抛错会让「选了个音色就再也合不成」不可用。
    const picked = resolveVoice(voice, list, spec.name, { invalidNumber: 'default' })
    return picked ? picked.name : list[0].name
  }

  async synthesize(text: string, voice: string): Promise<SynthAudio> {
    if (!this.isLoaded()) throw new Error('TTS 模型未加载')
    if (!text) return { samples: new Int16Array(0), sampleRate: 0 }

    const options: Record<string, string> = {}
    // 克隆激活时音色由参考音频决定，voice_id 不再参与
    const clone = this.inner.referenceAudio
    const voiceId = clone ? '' : this.resolveVoiceId(voice)
    if (voiceId) options.voice_id = voiceId
    // 参考文本：Qwen3-TTS 克隆需要它对齐参考音频内容
    if (clone && this.inner.referenceText) options.reference_text = this.inner.referenceText
    // 音色描述：与 voice_id / 克隆相互独立（C 侧把空 instructions 视为未设置）
    if (this.inner.instruct) options.instruct = this.inner.instruct

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
