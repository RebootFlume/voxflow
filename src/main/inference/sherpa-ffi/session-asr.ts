/**
 * sherpa-onnx ASR 会话：加载识别器 → 音频转文本。
 *
 * 这一层是「推理逻辑」本身，完全不认识 IPC：worker 调它，主进程不碰它。
 * 它复用随包运行时里的 sherpa-onnx-c-api.dll（v2.0.1）。
 */

import { existsSync } from 'node:fs'
import koffi from 'koffi'
import { loadSherpaFfi, type Handle, type SherpaFfi } from './bindings'
import type { AsrStage } from '../engine'

// 模型族词表在 models/framework-ids.ts（全仓库唯一一份：spec 声明、C 结构体、
// NUMERIC_DEFAULTS 三处共用）。这里 re-export 保持既有 import 路径可用。
import type { SherpaAsrFamily } from '../../models/framework-ids'

export type { SherpaAsrFamily }

export interface SherpaAsrSessionOptions {
  /** sherpa-onnx 运行时根目录（含 bin/ include/ lib/） */
  runtimeDir: string
  /** 模型族 */
  family: SherpaAsrFamily
  /** 主模型文件绝对路径 */
  modelPath: string
  /** tokens.txt 绝对路径 */
  tokensPath: string
  /** 推理提供者（"cpu" / "cuda"） */
  provider: string
  /** 线程数 */
  numThreads: number
  /** 语言（sense-voice 等支持指定语言；空 = 自动） */
  language?: string
  /** 是否启用逆文本规整（sense-voice） */
  useItn?: boolean
  /** 阶段回调 */
  onStage?: (stage: AsrStage) => void
}

/** 特征提取参数：sherpa 的 onnx 模型统一 16kHz / 80 维 fbank */
const FEATURE_SAMPLE_RATE = 16000
const FEATURE_DIM = 80

/** 结果 JSON 的最大读取长度（足够容纳一段话的识别结果） */
const RESULT_JSON_MAX_BYTES = 64 * 1024

/**
 * 一个已加载的识别器。
 *
 * 生命周期：open() → 若干次 transcribe() → close()。
 * 识别器内部无会话状态（每次转写新建一条 stream），可长期复用。
 */
export class SherpaAsrSession {
  private constructor(
    private readonly ffi: SherpaFfi,
    private readonly recognizer: Handle
  ) {}

  /**
   * 加载模型并创建识别器。
   *
   * 阶段上报：loading（加载 onnx 权重）→ ready。
   */
  static open(opts: SherpaAsrSessionOptions): SherpaAsrSession {
    if (!existsSync(opts.modelPath)) {
      throw new Error(`模型文件不存在: ${opts.modelPath}`)
    }
    if (!existsSync(opts.tokensPath)) {
      throw new Error(`模型缺少 tokens.txt: ${opts.tokensPath}`)
    }

    opts.onStage?.('loading')
    const ffi = loadSherpaFfi(opts.runtimeDir)

    // 各族的子结构体只有一个路径字段，按 family 放到对应位置
    const modelPath = opts.modelPath
    const one = { model: modelPath }
    const config = {
      feat_config: { sample_rate: FEATURE_SAMPLE_RATE, feature_dim: FEATURE_DIM },
      model_config: {
        transducer: { encoder: '', decoder: '', joiner: '' },
        paraformer: { model: '' },
        nemo_ctc: { model: '' },
        // 未支持的族（whisper 等）只作结构体占位：koffi 的 SherpaModelConfig
        // 布局必须与 C 头文件逐字段对齐，删字段会错位后面所有字段。
        whisper: {
          encoder: '',
          decoder: '',
          language: '',
          task: 'transcribe',
          tail_paddings: 0,
          enable_token_timestamps: 0,
          enable_segment_timestamps: 0
        },
        tdnn: { model: '' },
        tokens: opts.tokensPath,
        num_threads: opts.numThreads,
        debug: 0,
        provider: opts.provider,
        model_type: '',
        modeling_unit: '',
        bpe_vocab: '',
        telespeech_ctc: '',
        sense_voice: { model: '', language: opts.language ?? '', use_itn: opts.useItn ? 1 : 0 },
        moonshine: { preprocessor: '', encoder: '', uncached_decoder: '', cached_decoder: '', merged_decoder: '' },
        fire_red_asr: { encoder: '', decoder: '' },
        dolphin: { model: '' },
        zipformer_ctc: { model: '' },
        canary: { encoder: '', decoder: '', src_lang: '', tgt_lang: '', use_pnc: 0 },
        wenet_ctc: { model: '' },
        omnilingual: { model: '' },
        medasr: { model: '' },
        funasr_nano: {
          encoder_adaptor: '',
          llm: '',
          embedding: '',
          tokenizer: '',
          system_prompt: '',
          user_prompt: '',
          max_new_tokens: 0,
          temperature: 0,
          top_p: 0,
          seed: 0,
          language: '',
          itn: 0,
          hotwords: ''
        },
        fire_red_asr_ctc: { model: '' },
        qwen3_asr: {
          conv_frontend: '',
          encoder: '',
          decoder: '',
          tokenizer: '',
          max_total_len: 0,
          max_new_tokens: 0,
          temperature: 0,
          top_p: 0,
          seed: 0,
          hotwords: ''
        },
        cohere_transcribe: { encoder: '', decoder: '', language: '', use_punct: 0, use_itn: 0 }
      },
      lm_config: { model: '', scale: 1 },
      decoding_method: 'greedy_search',
      max_active_paths: 4,
      hotwords_file: '',
      hotwords_score: 1.5,
      rule_fsts: '',
      rule_fars: '',
      blank_penalty: 0,
      hr: { dict_dir: '', lexicon: '', rule_fsts: '' },
      // v2.0.1 新增（尾部）：不使用 HLG/FST 解码，graph 置空
      ctc_fst_decoder_config: { graph: '', max_active: 0 }
    }

    switch (opts.family) {
      case 'paraformer':
        config.model_config.paraformer = one
        break
      case 'sense_voice':
        config.model_config.sense_voice = {
          model: modelPath,
          language: opts.language ?? '',
          use_itn: opts.useItn === false ? 0 : 1
        }
        break
      case 'transducer':
        config.model_config.transducer = { encoder: modelPath, decoder: '', joiner: '' }
        break
      case 'nemo_ctc':
        config.model_config.nemo_ctc = one
        break
      default:
        throw new Error(`不支持的 sherpa ASR 模型族: ${String(opts.family)}`)
    }

    const recognizer = ffi.asr.create_recognizer(config)
    if (!recognizer) {
      throw new Error(`识别器创建失败: ${opts.modelPath}`)
    }
    opts.onStage?.('ready')
    return new SherpaAsrSession(ffi, recognizer)
  }

  /**
   * 转写一段音频。
   *
   * @param pcm [-1, 1] 的单声道采样
   * @param sampleRate 采样率（sherpa 的 onnx 模型要求 16kHz，由调用方保证）
   */
  transcribe(pcm: Float32Array, sampleRate: number): string {
    const { ffi, recognizer } = this
    if (pcm.length === 0) return ''

    const stream = ffi.asr.create_stream(recognizer)
    if (!stream) throw new Error('识别流创建失败')
    try {
      ffi.asr.accept_waveform(stream, sampleRate, pcm, pcm.length)
      ffi.asr.decode_stream(recognizer, stream)
      const jsonPtr = ffi.asr.get_result_json(stream)
      if (!jsonPtr) throw new Error('识别结果为空')
      try {
        const raw = koffi.decode(jsonPtr, 'char', RESULT_JSON_MAX_BYTES)
        return parseResult(typeof raw === 'string' ? raw.replace(/\0+$/, '') : '')
      } finally {
        ffi.asr.destroy_result_json(jsonPtr)
      }
    } finally {
      ffi.asr.destroy_stream(stream)
    }
  }

  /** 释放识别器（worker 卸载模型 / 退出时调用） */
  close(): void {
    try {
      this.ffi.asr.destroy_recognizer(this.recognizer)
    } catch {
      // 进程即将退出时可能已失效
    }
  }
}

/**
 * 解析 sherpa 返回的 JSON，提取 text 字段。
 *
 * 空结果不是错误：静音片段识别为空是正常现象，由上层决定怎么展示。
 */
export function parseResult(raw: string): string {
  let value: Record<string, unknown>
  try {
    value = JSON.parse(raw) as Record<string, unknown>
  } catch (e) {
    throw new Error(`转写结果解析失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  return typeof value.text === 'string' ? value.text.trim() : ''
}
