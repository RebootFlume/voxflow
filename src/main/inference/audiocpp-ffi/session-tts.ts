/**
 * audio.cpp TTS 会话：加载模型 → 文本合成音频。
 *
 * 这一层是「推理逻辑」本身，不认识 IPC、不认识描述符；族差异由 C 侧按
 * `family_hint` 识别（模型自带 spec），我们只负责传文本和取音频。
 */

import { loadAudiocppFfi, type AudiocppFfi, type Handle } from './bindings'

export interface AudiocppTtsSessionOptions {
  /** audio.cpp 运行时根目录（<libs>/audio-cpp） */
  runtimeDir: string
  /** 主模型文件绝对路径 */
  modelPath: string
  /** 族名（空 = 让 C 侧按路径识别） */
  familyHint: string
  /** 后端（"cpu" / "cuda" / "vulkan"…） */
  backend: string
  /** 线程数 */
  numThreads: number
}

/** 合成参数 */
export interface AudiocppSynthOptions {
  /** 语言（空 = 自动） */
  language: string
  /** 请求级选项（如 voice_id） */
  options: Record<string, string>
}

/** 合成结果（采样为 [-1,1] 浮点，由调用方转 16bit） */
export interface AudiocppAudio {
  samples: Float32Array
  sampleRate: number
}

/** 把交错多声道混成单声道 */
function toMono(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return samples
  const frames = Math.floor(samples.length / channels)
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += samples[i * channels + c]
    mono[i] = sum / channels
  }
  return mono
}

/** audio.cpp TTS 会话（持有 registry / model / session，close 时按序释放） */
export class AudiocppTtsSession {
  private readonly ffi: AudiocppFfi
  private readonly registry: Handle
  private model: Handle | null = null
  private session: Handle | null = null
  private closed = false

  private constructor(ffi: AudiocppFfi, registry: Handle) {
    this.ffi = ffi
    this.registry = registry
  }

  /** 打开会话：加载 dll → 建 registry → 载模型 → 建 tts 会话 */
  static open(opts: AudiocppTtsSessionOptions): AudiocppTtsSession {
    const ffi = loadAudiocppFfi(opts.runtimeDir)
    const registry = ffi.registry_create()
    let session: AudiocppTtsSession | null = null
    try {
      const self = new AudiocppTtsSession(ffi, registry)
      session = self

      const model = ffi.model_load(registry, opts.modelPath, {
        familyHint: opts.familyHint || null
      })
      self.model = model

      if (!ffi.model_supports(model, 'tts', 'offline')) {
        throw new Error(
          `模型 ${opts.familyHint || ffi.model_family(model)} 不支持 tts/offline`
        )
      }

      self.session = ffi.session_create(model, 'tts', 'offline', {
        backend: opts.backend,
        device: 0,
        threads: opts.numThreads
      })
      return self
    } catch (e) {
      session?.close()
      if (!session) {
        try {
          ffi.registry_free(registry)
        } catch {
          /* 已经在错误路径上，忽略释放失败 */
        }
      }
      throw e
    }
  }

  /** 合成一段文本 */
  synthesize(text: string, opts: AudiocppSynthOptions): AudiocppAudio {
    if (this.closed || !this.session) throw new Error('TTS 模型未加载')
    const ffi = this.ffi

    const request = ffi.request_create()
    let result: Handle | null = null
    try {
      ffi.request_set_text(request, text, opts.language || null)
      for (const [key, value] of Object.entries(opts.options)) {
        ffi.request_set_option(request, key, value)
      }
      result = ffi.session_run(this.session, request)
      const audio = ffi.result_audio(result)
      if (!audio || audio.sampleRate <= 0) {
        throw new Error('audio.cpp 未返回音频')
      }
      return {
        samples: toMono(audio.samples, audio.channels),
        sampleRate: audio.sampleRate
      }
    } finally {
      if (result) ffi.result_free(result)
      ffi.request_free(request)
    }
  }

  /** 释放会话与模型（幂等） */
  close(): void {
    if (this.closed) return
    this.closed = true
    const ffi = this.ffi
    if (this.session) {
      try {
        ffi.session_free(this.session)
      } catch {
        /* 释放失败不阻断 */
      }
      this.session = null
    }
    if (this.model) {
      try {
        ffi.model_free(this.model)
      } catch {
        /* 同上 */
      }
      this.model = null
    }
    try {
      ffi.registry_free(this.registry)
    } catch {
      /* 同上 */
    }
  }
}
