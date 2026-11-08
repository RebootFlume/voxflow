/**
 * sherpa-onnx E2E TTS 引擎（进程内 FFI，描述符驱动）
 * —— 对齐 Rust 版 `src-tauri/src/tts/engine/sherpa.rs` 的契约，实现换成 C API 直调。
 *
 * 架构：worker 子进程里 `sherpa-onnx-c-api.dll` + onnxruntime 直接合成，
 * 不再 spawn `sherpa-onnx-offline-tts.exe`，也不再有临时 wav 文件往返。
 *
 * 职责边界（低耦合）：
 * - 模型差异全部收敛在 `ModelSpec` 描述符（spec-data.ts）+ `sherpa-model-config.ts` 解释器；
 * - 进程/协议在 `inference/sherpa-ffi/host.ts`；
 * - 推理本身在 worker 的 `session-tts.ts`。
 */

import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { findSpec, getModelRoot } from '../models/model-manager'
import type { ModelSpec, VoiceModeSpec } from '../models/spec-data'
import { sherpaRuntimeDir } from '../inference/runtime-paths'
import { SherpaTtsHost } from '../inference/sherpa-ffi/host'
import { readWav, toMono } from '../audio/wav'
import { buildTtsModelPayload, resolveMainModelFile } from './sherpa-model-config'
import type { SynthAudio, TtsEngine } from './traits'

/** 引擎可变状态 */
interface SherpaInner {
  /** 当前模型描述符（null = 未加载） */
  spec: ModelSpec | null
  /** 模型目录 */
  modelDir: string
  /** models 根目录 */
  modelRoot: string
  /** 说话人 ID（Kokoro / Supertonic 等多说话人模型） */
  sid: number
  /** 推理提供者（由 device 映射：cpu / cuda） */
  provider: string
  /** 推理线程数 */
  numThreads: number
  /** 当前语言（Supertonic 等需 language 的模型使用） */
  language: string
  /** 语音克隆：参考音频路径（ZipVoice 使用） */
  referenceAudio: string | null
  /** 语音克隆：参考音频对应的文本 */
  referenceText: string | null
}

/** 合成语速倍率（与旧 CLI 实现一致：固定 1.0） */
const SYNTH_SPEED = 1

/** 从模型文件路径解析描述符：目录名优先（models_root/<dir>/model.onnx），文件名兜底。 */
function resolveSpec(modelPath: string): ModelSpec | undefined {
  const dir = dirname(modelPath)
  const dirName = basename(dir)
  if (dirName) {
    const spec = findSpec(dirName)
    if (spec) return spec
  }
  const name = basename(modelPath)
  return name ? findSpec(name) : undefined
}

/** 克隆能力的"是否必须配参考文本"（来自描述符，不做模型名分支） */
function cloneRequiresText(voiceMode: VoiceModeSpec): boolean | null {
  if (voiceMode.type === 'clone') return voiceMode.requiresText
  if (voiceMode.type === 'presetAndClone') return voiceMode.clone.requiresText
  return null
}

/** sherpa-onnx E2E TTS 引擎（进程内 FFI） */
export class SherpaTtsEngine implements TtsEngine {
  private inner: SherpaInner
  private readonly host: SherpaTtsHost

  constructor(host: SherpaTtsHost = new SherpaTtsHost()) {
    this.host = host
    this.inner = {
      spec: null,
      modelDir: '',
      modelRoot: getModelRoot(),
      sid: 0,
      provider: 'cuda',
      numThreads: 4,
      language: 'zh',
      referenceAudio: null,
      referenceText: null
    }
  }

  // ── TtsEngine 实现 ────────────────────────────────────────────────────────

  name(): string {
    return this.inner.spec?.id ?? ''
  }

  async load(modelPath: string, device: string): Promise<void> {
    const spec = resolveSpec(modelPath)
    if (!spec) throw new Error(`无法识别 TTS 模型: ${modelPath}`)
    if (spec.backend.type !== 'sherpaTts') {
      throw new Error(`${spec.name} 不是 sherpa TTS 模型`)
    }

    const runtimeDir = sherpaRuntimeDir()
    if (!existsSync(runtimeDir)) {
      throw new Error(`sherpa-onnx 推理框架未安装: ${runtimeDir}`)
    }

    // 候选状态先写入再校验，校验失败必须回滚：否则 isLoaded()（= spec 非空）会谎报已加载
    const prevSpec = this.inner.spec
    const prevProvider = this.inner.provider
    this.inner.spec = spec
    this.inner.modelDir = dirname(modelPath)
    this.inner.provider = device.trim().toLowerCase() === 'cpu' ? 'cpu' : 'cuda'

    try {
      const { payload, missing } = buildTtsModelPayload(spec, {
        modelDir: this.inner.modelDir,
        modelsRoot: this.inner.modelRoot,
        mainModelFile: resolveMainModelFile(this.inner.modelDir)
      })
      if (missing.length > 0) {
        throw new Error(
          `模型 ${spec.name} 缺少文件：${missing.join('、')}；请到「模型与设备」重新下载该模型`
        )
      }
      await this.host.load({
        runtimeDir,
        model: payload,
        provider: this.inner.provider,
        numThreads: this.inner.numThreads
      })
    } catch (e) {
      this.inner.spec = prevSpec
      this.inner.provider = prevProvider
      throw e
    }

    // 语言对齐：当前语言不在描述符支持列表 → 切到 "en"（有则用）否则首个支持语言
    if (!spec.languages.includes(this.inner.language)) {
      const fallback = spec.languages.includes('en') ? 'en' : spec.languages[0]
      if (fallback) this.inner.language = fallback
    }
  }

  async unload(): Promise<void> {
    await this.host.unload()
    this.inner.spec = null
    this.inner.modelDir = ''
    this.inner.referenceAudio = null
    this.inner.referenceText = null
  }

  isLoaded(): boolean {
    return this.inner.spec !== null
  }

  async setLanguage(language: string): Promise<void> {
    const spec = this.inner.spec
    if (spec && !spec.languages.includes(language)) {
      throw new Error(
        `模型 ${spec.name} 不支持语言 '${language}'（支持: ${spec.languages.join(', ')}）`
      )
    }
    this.inner.language = language
  }

  /**
   * 设置语音克隆参数（ZipVoice 等克隆模型）。
   *
   * 能力来自描述符（不做模型名分支）：只有 clone / presetAndClone 接受克隆参数。
   */
  async setCloneVoice(audio: string, text: string): Promise<void> {
    const spec = this.inner.spec
    if (!spec) throw new Error('TTS 模型未加载，无法设置克隆音色')

    const requiresText = cloneRequiresText(spec.voiceMode)
    if (requiresText === null) {
      throw new Error(`当前 TTS 模型（${spec.name}）不支持语音克隆`)
    }

    const trimmed = text.trim()
    if (requiresText && !trimmed) {
      throw new Error(`模型 ${spec.name} 需要参考文本（参考音频里说的内容）`)
    }
    if (!existsSync(audio)) {
      throw new Error(`参考音频不存在: ${audio}`)
    }

    this.inner.referenceAudio = audio
    this.inner.referenceText = trimmed ? trimmed : null
  }

  /** 清除语音克隆参数（回到预设音色） */
  clearCloneVoice(): void {
    this.inner.referenceAudio = null
    this.inner.referenceText = null
  }

  async synthesize(text: string, voice: string): Promise<SynthAudio> {
    if (!this.isLoaded()) throw new Error('TTS 模型未加载')
    if (!text) return { samples: new Int16Array(0), sampleRate: 0 }

    // voice 参数作为 sid（如 "45"）；非法值保持当前 sid（与旧实现一致）
    const sid = Number.parseInt(voice, 10)
    if (Number.isFinite(sid)) this.inner.sid = sid

    const reference = this.readReferenceAudio()

    const reply = await this.host.synthesize({
      text,
      sid: this.inner.sid,
      speed: SYNTH_SPEED,
      referenceAudio: reference?.samples ?? null,
      referenceSampleRate: reference?.sampleRate ?? 0,
      referenceText: this.inner.referenceText ?? ''
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

  /** 读参考音频（单声道浮点）；没设置或读失败 → null（回退预设音色） */
  private readReferenceAudio(): { samples: Float32Array; sampleRate: number } | null {
    const path = this.inner.referenceAudio
    if (!path) return null
    try {
      const wav = readWav(path)
      return { samples: toMono(wav.samples, wav.channels), sampleRate: wav.sampleRate }
    } catch {
      return null
    }
  }
}
