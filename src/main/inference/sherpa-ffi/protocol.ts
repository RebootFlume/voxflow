/**
 * sherpa-onnx FFI worker 的命令载荷。
 *
 * 设计要点：worker **不做模型解析**。主进程把「文件都已定位好、路径都已绝对化」
 * 的配置发过来，worker 只负责 koffi 调 C API。这样 worker 里不需要认识
 * spec-data / model-manager，依赖方向始终是「主进程 → worker」单向。
 */

import type { SherpaAsrFamily } from './session-asr'
import type { SherpaTtsFamily } from './session-tts'

/** 加载 ASR 模型 */
export interface LoadAsrRequest {
  /** sherpa-onnx 运行时根目录 */
  runtimeDir: string
  /** 模型族（决定路径放哪个子结构体） */
  family: SherpaAsrFamily
  /** 主模型文件绝对路径 */
  modelPath: string
  /** tokens.txt 绝对路径 */
  tokensPath: string
  /** "cpu" / "cuda" */
  provider: string
  /** 推理线程数 */
  numThreads: number
  /** 语言（sense-voice 可指定；空 = 自动） */
  language: string
  /** 是否启用逆文本规整（sense-voice） */
  useItn: boolean
}

/** 转写请求 */
export interface TranscribeRequest {
  /** [-1, 1] 单声道采样 */
  pcm: Float32Array
  /** 采样率 */
  sampleRate: number
}

/** TTS 模型的各族路径配置（与 C 结构体同构，字段名即 C 字段名） */
export interface TtsModelPayload {
  family: SherpaTtsFamily
  /** 该族的 C 结构体字段（字符串字段都是绝对路径或空串） */
  fields: Record<string, string | number>
  /** TTS 规则 fst（逗号分隔的绝对路径；空串 = 不用） */
  ruleFsts: string
  ruleFars: string
  maxNumSentences: number
  silenceScale: number
}

/** 加载 TTS 模型 */
export interface LoadTtsRequest {
  runtimeDir: string
  model: TtsModelPayload
  provider: string
  numThreads: number
}

/** 合成请求 */
export interface SynthesizeRequest {
  text: string
  /** 说话人 id（多说话人模型） */
  sid: number
  /** 语速倍率 */
  speed: number
  /** 语音克隆参考音频（单声道 [-1,1]；null = 不用） */
  referenceAudio: Float32Array | null
  referenceSampleRate: number
  /** 语音克隆参考文本（ZipVoice 需要） */
  referenceText: string
}

/** 合成结果 */
export interface SynthesizeReply {
  /** 16bit 单声道 PCM */
  samples: Int16Array
  sampleRate: number
}
