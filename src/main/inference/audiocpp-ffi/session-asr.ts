/**
 * audio.cpp ASR 会话：加载模型 → 音频进 → 文本出。
 *
 * 与 session-tts 同一形状：这一层只认识 C ABI，不认识 IPC / 描述符。
 * 族差异由 C 侧按 `family_hint` 识别（模型自带 spec）。
 */

import { loadAudiocppFfi, type AudiocppFfi, type Handle } from './bindings'

export interface AudiocppAsrSessionOptions {
  /** audio.cpp 运行时根目录（CPU / CUDA 变体各自的目录） */
  runtimeDir: string
  /** 主模型文件绝对路径 */
  modelPath: string
  /** 族名（空 = 让 C 侧按路径识别） */
  familyHint: string
  /** 后端（"cpu" / "cuda"） */
  backend: string
  /** 线程数 */
  numThreads: number
}

/** audio.cpp ASR 会话（持有 registry / model / session，close 时按序释放） */
export class AudiocppAsrSession {
  private readonly ffi: AudiocppFfi
  private readonly registry: Handle
  private model: Handle | null = null
  private session: Handle | null = null
  private closed = false

  private constructor(ffi: AudiocppFfi, registry: Handle) {
    this.ffi = ffi
    this.registry = registry
  }

  /** 打开会话：加载 dll → 建 registry → 载模型 → 建 asr 会话 */
  static open(opts: AudiocppAsrSessionOptions): AudiocppAsrSession {
    const ffi = loadAudiocppFfi(opts.runtimeDir)
    const registry = ffi.registry_create()
    let session: AudiocppAsrSession | null = null
    try {
      const self = new AudiocppAsrSession(ffi, registry)
      session = self

      const model = ffi.model_load(registry, opts.modelPath, {
        familyHint: opts.familyHint || null
      })
      self.model = model

      if (!ffi.model_supports(model, 'asr', 'offline')) {
        throw new Error(
          `模型 ${opts.familyHint || ffi.model_family(model)} 不支持 asr/offline`
        )
      }

      self.session = ffi.session_create(model, 'asr', 'offline', {
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

  /** 转写一段单声道音频 */
  transcribe(samples: Float32Array, sampleRate: number): string {
    if (this.closed || !this.session) throw new Error('ASR 模型未加载')
    if (samples.length === 0) return ''
    const ffi = this.ffi

    const request = ffi.request_create()
    let result: Handle | null = null
    try {
      // frames 是「每声道帧数」；我们送进去的本来就是单声道
      ffi.request_set_audio(request, samples, samples.length, sampleRate, 1)
      result = ffi.session_run(this.session, request)
      return ffi.result_text(result)
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
