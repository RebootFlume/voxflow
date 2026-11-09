/**
 * sherpa-onnx TTS 会话：加载合成器 → 文本转音频。
 *
 * 与 ASR 会话同构：这一层是「推理逻辑」本身，不认识 IPC。
 * 模型族差异（7 个族）收敛在 C 结构体的子结构体里，这层只按族放入对应字段。
 */

import { existsSync } from 'node:fs'
import { loadSherpaFfi, type Handle, type SherpaFfi } from './bindings'
import type { TtsModelPayload } from './protocol'

// TTS 模型族（= C API 的 7 个子结构体）词表在 shared/framework-ids.ts
import type { SherpaTtsFamily } from '../../../shared/framework-ids'

export type { SherpaTtsFamily }

export interface SherpaTtsSessionOptions {
  /** sherpa-onnx 运行时根目录 */
  runtimeDir: string
  /** 模型族 + 该族字段（路径已绝对化） */
  model: TtsModelPayload
  /** 推理提供者（"cpu" / "cuda"） */
  provider: string
  /** 线程数 */
  numThreads: number
}

/** 合成参数 */
export interface SherpaTtsSynthOptions {
  /** 说话人 id（多说话人模型） */
  sid: number
  /** 语速倍率 */
  speed: number
  /** 语音克隆参考音频（单声道 [-1,1]；null = 不用） */
  referenceAudio: Float32Array | null
  referenceSampleRate: number
  /** 语音克隆参考文本 */
  referenceText: string
  /** 族级合成选项 JSON（透传到 C 的 `GenerationConfig.extra`）；空串 = 不设置 */
  extra: string
}

/** 合成结果（采样为 [-1,1] 浮点，由调用方转 16bit） */
export interface SherpaTtsAudio {
  samples: Float32Array
  sampleRate: number
}

/**
 * 一个已加载的合成器。
 *
 * 生命周期：open() → 若干次 synthesize() → close()。
 */
export class SherpaTtsSession {
  private constructor(
    private readonly ffi: SherpaFfi,
    private readonly tts: Handle
  ) {}

  /** 加载模型并创建合成器 */
  static open(opts: SherpaTtsSessionOptions): SherpaTtsSession {
    const { model } = opts
    // 字段值里凡是路径，都必须是真实存在的（缺文件时给出点名而非 C 侧一句 "Errors in config!"）。
    // 多值字段（lexicon / rule_fsts）用逗号拼接，需要逐段校验。
    for (const [key, value] of Object.entries(model.fields)) {
      if (typeof value !== 'string' || value.length === 0) continue
      for (const part of value.split(',')) {
        if (!looksLikePath(part)) continue
        if (!existsSync(part)) throw new Error(`模型缺少文件: ${key} = ${part}`)
      }
    }

    const ffi = loadSherpaFfi(opts.runtimeDir)

    // C 结构体要求的子结构体必须全部给出（未用到的保持空值）
    const config = {
      model: {
        vits: emptyVits(),
        num_threads: opts.numThreads,
        debug: 0,
        provider: opts.provider,
        matcha: emptyMatcha(),
        kokoro: emptyKokoro(),
        kitten: emptyKitten(),
        zipvoice: emptyZipvoice(),
        pocket: emptyPocket(),
        supertonic: emptySupertonic()
      },
      rule_fsts: model.ruleFsts,
      max_num_sentences: model.maxNumSentences,
      rule_fars: model.ruleFars,
      silence_scale: model.silenceScale
    }

    // 只把字段填进该族对应的子结构体，其余保持空（C 侧按「哪个族非空」判断模型类型）
    const target = config.model[model.family] as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(model.fields)) {
      target[key] = value
    }

    const tts = ffi.tts.create_tts(config)
    if (!tts) {
      throw new Error('TTS 合成器创建失败（模型配置不完整或运行库不匹配）')
    }
    return new SherpaTtsSession(ffi, tts)
  }

  /** 合成一段文本 */
  synthesize(text: string, opts: SherpaTtsSynthOptions): SherpaTtsAudio {
    const { ffi, tts } = this
    if (!text) return { samples: new Float32Array(0), sampleRate: 0 }

    // 需要参考音频（ZipVoice 克隆）或族级选项（Supertonic 的 lang）时走带 config 的接口。
    // 简单接口 SherpaOnnxOfflineTtsGenerate 只有 text/sid/speed 三个参数，表达不了 extra ——
    // 之前 Supertonic 的语言下拉选了不生效，就是因为它一直走的是这条简单路径。
    const needsConfig = Boolean(opts.referenceAudio) || opts.extra !== ''
    const audio = needsConfig
      ? this.generateWithConfig(text, opts)
      : ffi.tts.generate(tts, text, opts.sid, opts.speed)
    if (!audio) throw new Error('合成失败（C API 返回空结果）')

    try {
      return ffi.read_generated_audio(audio)
    } finally {
      ffi.tts.destroy_generated_audio(audio)
    }
  }

  /** 带完整合成参数（参考音频 / 族级 extra） */
  private generateWithConfig(text: string, opts: SherpaTtsSynthOptions): Handle {
    const built = this.ffi.make_generation_config({
      sid: opts.sid,
      speed: opts.speed,
      referenceAudio: opts.referenceAudio,
      referenceSampleRate: opts.referenceSampleRate,
      referenceText: opts.referenceText,
      extra: opts.extra
    })
    // keepAlive 必须活到调用结束（里面的浮点缓冲是指针的目标）
    void built.keepAlive
    // callback / arg 传 null：进度回调对本集成没用（合成是同步阻塞的）
    return this.ffi.tts.generate_with_config(this.tts, text, built.handle, null, null)
  }

  /** 释放合成器 */
  close(): void {
    try {
      this.ffi.tts.destroy_tts(this.tts)
    } catch {
      // 进程即将退出时可能已失效
    }
  }
}

/** 粗判字符串是不是路径（用于加载期校验：空串与语言名不算） */
function looksLikePath(value: string): boolean {
  return value.length > 0 && (value.includes('/') || value.includes('\\'))
}

function emptyVits(): Record<string, unknown> {
  return {
    model: '',
    lexicon: '',
    tokens: '',
    data_dir: '',
    noise_scale: 0,
    noise_scale_w: 0,
    length_scale: 0,
    dict_dir: ''
  }
}

function emptyMatcha(): Record<string, unknown> {
  return {
    acoustic_model: '',
    vocoder: '',
    lexicon: '',
    tokens: '',
    data_dir: '',
    noise_scale: 0,
    length_scale: 0,
    dict_dir: ''
  }
}

function emptyKokoro(): Record<string, unknown> {
  return {
    model: '',
    voices: '',
    tokens: '',
    data_dir: '',
    length_scale: 0,
    dict_dir: '',
    lexicon: '',
    lang: ''
  }
}

function emptyKitten(): Record<string, unknown> {
  // v2.0.1 在尾部新增 lexicon
  return { model: '', voices: '', tokens: '', data_dir: '', length_scale: 0, lexicon: '' }
}

function emptyZipvoice(): Record<string, unknown> {
  return {
    tokens: '',
    encoder: '',
    decoder: '',
    vocoder: '',
    data_dir: '',
    lexicon: '',
    feat_scale: 0,
    t_shift: 0,
    target_rms: 0,
    guidance_scale: 0
  }
}

function emptyPocket(): Record<string, unknown> {
  return {
    lm_flow: '',
    lm_main: '',
    encoder: '',
    decoder: '',
    text_conditioner: '',
    vocab_json: '',
    token_scores_json: '',
    voice_embedding_cache_capacity: 0
  }
}

function emptySupertonic(): Record<string, unknown> {
  return {
    duration_predictor: '',
    text_encoder: '',
    vector_estimator: '',
    vocoder: '',
    tts_json: '',
    unicode_indexer: '',
    voice_style: ''
  }
}
