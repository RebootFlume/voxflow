/**
 * audio.cpp FFI worker 的命令载荷。
 *
 * 与 sherpa-ffi 同一设计：worker **不做模型解析**，主进程把「族名 + 绝对路径」
 * 发过来，worker 只负责 koffi 调 C API。
 */

/** 加载 TTS 模型 */
export interface LoadTtsRequest {
  /** audio.cpp 运行时根目录（<libs>/audio-cpp） */
  runtimeDir: string
  /** 主模型文件绝对路径（.gguf） */
  modelPath: string
  /** 模型族名（对应 audiocpp 的 family，如 "moss_tts_nano"；空 = 按路径自动识别） */
  familyHint: string
  /** 后端（"cpu" / "cuda"） */
  backend: string
  /** 推理线程数 */
  numThreads: number
}

/** 合成请求 */
export interface SynthesizeRequest {
  text: string
  /** 语言（可空 = 自动） */
  language: string
  /** 请求级选项（如 voice_id / speaker / reference_text） */
  options: Record<string, string>
  /** 克隆参考音频（说话人参考；缺省 = 不用克隆） */
  voiceAudio?: {
    /** 交错 float PCM */
    samples: Float32Array
    /** 每声道帧数 */
    frames: number
    sampleRate: number
    channels: number
  }
}

/** 合成结果 */
export interface SynthesizeReply {
  /** 16bit 单声道 PCM */
  samples: Int16Array
  sampleRate: number
}

/** 加载 ASR 模型 */
export interface LoadAsrRequest {
  /** audio.cpp 运行时根目录（<libs>/audio-cpp） */
  runtimeDir: string
  /** 主模型文件绝对路径（.gguf） */
  modelPath: string
  /** 模型族名（如 "qwen3_asr"；空 = 按路径自动识别） */
  familyHint: string
  /** 后端（"cpu" / "cuda"） */
  backend: string
  /** 推理线程数 */
  numThreads: number
}

/** 转写请求 */
export interface TranscribeRequest {
  /** 单声道 [-1,1] 浮点 PCM */
  samples: Float32Array
  sampleRate: number
}

/** 转写结果 */
export interface TranscribeReply {
  text: string
}
