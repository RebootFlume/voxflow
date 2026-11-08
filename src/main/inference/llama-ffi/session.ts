/**
 * llama.cpp 进程内会话：加载模型 → 音频转文本。
 *
 * 这一层是「推理逻辑」本身，完全不认识 IPC：worker 调它，主进程不碰它。
 * 它复用随包运行时里的 llama.dll / mtmd.dll（llama.cpp tag b10622）。
 */

import { cpus } from 'node:os'
import koffi from 'koffi'
import { loadLlamaFfi, type Handle, type LlamaFfi } from './bindings'
import { encodePcmToWav } from '../audio-wav'
import { extractAsrText } from '../asr-text'
import type { AsrStage } from '../engine'

/** mtmd 的媒体占位符（必须与 mtmd 默认 marker 一致） */
const MEDIA_MARKER = '<__media__>'

/** Qwen3-ASR 的对话模板（ChatML） */
const PROMPT_TEMPLATE = '<|im_start|>user\n{context}<__media__><|im_end|>\n<|im_start|>assistant\n'

/** 采样上限（防止模型不收敛导致无限循环） */
const MAX_TOKENS = 256

export interface LlamaSessionOptions {
  /** llama.cpp 运行时目录 */
  libsDir: string
  /** GGUF 主模型绝对路径 */
  modelPath: string
  /** mmproj 绝对路径（音频前端） */
  mmprojPath: string
  /** 推理设备 */
  device: 'cuda' | 'cpu'
  /** 上下文长度 */
  ctxSize: number
  /** 阶段回调 */
  onStage?: (stage: AsrStage) => void
}

/**
 * 上下文文本消毒：去掉可能破坏 chat 模板的特殊标记片段。
 *
 * 上文来自用户历史（可能是任意文本），而提示词里的 `<|...|>` 是模型的保留标记，
 * 直接拼进去会让模型把上文当成结构化标记解析。
 */
function sanitizeContext(context: string): string {
  return context.replace(/<\|[^>]*\|>/g, '').trim()
}

/**
 * 一个已加载模型的推理会话。
 *
 * 生命周期：open() → 若干次 transcribe() → close()。
 * 每次 transcribe 前会清空 KV cache，因此会话可长期复用。
 */
/**
 * 读 CUDA 设备的空闲显存（MiB）。
 *
 * 用途：引擎自报显存占用（加载前后的空闲显存差值），
 * 这样显存面板不用再去查"别的进程"（旧的 WMI/PowerShell 路线要 3.3s）。
 *
 * 没有 CUDA 设备（CPU 路线）或读不到 → null。
 */
function readDeviceFreeMb(ffi: LlamaFfi): number | null {
  try {
    const dev = ffi.ggml.backend_dev_by_name('CUDA0')
    if (!dev) return null
    const free = Buffer.alloc(8)
    const total = Buffer.alloc(8)
    ffi.ggml.backend_dev_memory(dev, free, total)
    const bytes = free.readBigUInt64LE(0)
    if (!Number.isFinite(Number(bytes))) return null
    return Number(bytes) / (1024 * 1024)
  } catch {
    return null
  }
}

export class LlamaSession {
  private constructor(
    private readonly ffi: LlamaFfi,
    private readonly model: Handle,
    private readonly ctx: Handle,
    private readonly vocab: Handle,
    private readonly mtmdCtx: Handle,
    private readonly memory: Handle,
    /** 本引擎实际占用的设备显存（MiB）；读不到 → null */
    private readonly deviceVramMb: number | null
  ) {}

  /** 本引擎实际占用的设备显存（MiB）—— 加载前后的设备空闲显存差值 */
  vramMb(): number | null {
    return this.deviceVramMb
  }

  /**
   * 加载模型并建立上下文。
   *
   * 阶段上报：loading（读权重）→ initializing（建上下文 / 音频前端）→ ready。
   */
  static open(opts: LlamaSessionOptions): LlamaSession {
    const { onStage } = opts
    const device = opts.device === 'cpu' ? 'cpu' : 'cuda'
    const ffi = loadLlamaFfi(opts.libsDir)

    // 动态后端必须显式按路径加载：默认实现只在自己 exe 旁边找 ggml-cuda.dll
    ffi.ggml.backend_load_all_from_path(opts.libsDir)
    ffi.llama.backend_init()

    // 设备显存基线（加载模型之前）：之后用差值算出"本引擎占了多少显存"。
    // 这样就不必去查别的进程（WMI/PowerShell），引擎自己就能回答。
    const baselineFreeMb = device === 'cuda' ? readDeviceFreeMb(ffi) : null

    onStage?.('loading')
    const modelParams = ffi.llama.model_default_params()
    // n_gpu_layers = -1 → 全部层上 GPU；CPU 路线置 0
    modelParams.n_gpu_layers = device === 'cuda' ? -1 : 0
    const model = ffi.llama.model_load_from_file(opts.modelPath, modelParams)
    if (!model) {
      ffi.llama.backend_free()
      throw new Error(`模型加载失败: ${opts.modelPath}`)
    }

    onStage?.('initializing')
    const ctxParams = ffi.llama.context_default_params()
    ctxParams.n_ctx = opts.ctxSize
    ctxParams.n_batch = 2048
    ctxParams.n_ubatch = 512
    const cpuCount = Math.max(1, cpus().length)
    ctxParams.n_threads = Math.max(1, Math.floor(cpuCount / 2))
    ctxParams.n_threads_batch = cpuCount
    const ctx = ffi.llama.init_from_model(model, ctxParams)
    if (!ctx) {
      ffi.llama.model_free(model)
      ffi.llama.backend_free()
      throw new Error(`推理上下文创建失败: ${opts.modelPath}`)
    }

    if (!opts.mmprojPath) {
      ffi.llama.free(ctx)
      ffi.llama.model_free(model)
      ffi.llama.backend_free()
      throw new Error('该模型缺少 mmproj（音频前端）文件，无法转写')
    }
    const caps = ffi.mtmd.get_cap_from_file(opts.mmprojPath)
    if (!caps?.inp_audio) {
      ffi.llama.free(ctx)
      ffi.llama.model_free(model)
      ffi.llama.backend_free()
      throw new Error(`mmproj 不支持音频输入: ${opts.mmprojPath}`)
    }
    const mtmdParams = ffi.mtmd.context_params_default()
    mtmdParams.use_gpu = device === 'cuda'
    mtmdParams.n_threads = ctxParams.n_threads
    mtmdParams.media_marker = MEDIA_MARKER
    const mtmdCtx = ffi.mtmd.init_from_file(opts.mmprojPath, model, mtmdParams)
    if (!mtmdCtx) {
      ffi.llama.free(ctx)
      ffi.llama.model_free(model)
      ffi.llama.backend_free()
      throw new Error(`音频前端初始化失败: ${opts.mmprojPath}`)
    }

    const vocab = ffi.llama.model_get_vocab(model)
    const memory = ffi.llama.get_memory(ctx)
    // 本引擎实际占用 = 加载前后的设备空闲显存差值
    const afterFreeMb = device === 'cuda' ? readDeviceFreeMb(ffi) : null
    const deviceVramMb =
      baselineFreeMb !== null && afterFreeMb !== null
        ? Math.max(0, baselineFreeMb - afterFreeMb)
        : null
    onStage?.('ready')
    return new LlamaSession(ffi, model, ctx, vocab, mtmdCtx, memory, deviceVramMb)
  }

  /**
   * 转写一段音频。
   *
   * @param pcm  [-1, 1] 的单声道采样
   * @param sampleRate 采样率
   * @param context 上文（可选）
   */
  transcribe(pcm: Float32Array, sampleRate: number, context = ''): string {
    const { ffi } = this
    if (pcm.length === 0) return ''

    // 长驻进程要复用上下文：每次转写前清空 KV cache
    ffi.llama.memory_clear(this.memory, true)

    const wav = encodePcmToWav(pcm, sampleRate)
    const wrapper = ffi.mtmd.helper_bitmap_init_from_buf(this.mtmdCtx, wav, wav.length, false)
    if (!wrapper?.bitmap) throw new Error('音频解码失败（mtmd bitmap 为空）')

    const chunks = ffi.mtmd.input_chunks_init()
    const bitmaps = koffi.alloc('void *', 1)
    koffi.encode(bitmaps, 0, 'void *', wrapper.bitmap)
    try {
      const prompt = PROMPT_TEMPLATE.replace('{context}', sanitizeContext(context))
      const rc = ffi.mtmd.tokenize(
        this.mtmdCtx,
        chunks,
        {
          text: prompt,
          text_len: Buffer.byteLength(prompt),
          add_special: false,
          // 必须开启：否则 chat 模板里的 <|im_start|> 会被当普通文本，模型直接吐结束符
          parse_special: true
        },
        bitmaps,
        1
      )
      if (rc !== 0) throw new Error(`音频分词失败 (rc=${rc})`)

      // 把音频 chunk 编码进 LLM 上下文
      const newPast = Buffer.alloc(4)
      const evalRc = ffi.mtmd.helper_eval_chunks(
        this.mtmdCtx,
        this.ctx,
        chunks,
        0,
        0,
        512,
        true,
        newPast
      )
      if (evalRc !== 0) throw new Error(`音频编码失败 (rc=${evalRc})`)

      return extractAsrText(this.sample())
    } finally {
      ffi.mtmd.input_chunks_free(chunks)
      ffi.mtmd.bitmap_free(wrapper.bitmap)
    }
  }

  /** 采样生成文本（贪心解码，与官方 CLI 默认一致） */
  private sample(): string {
    const { ffi } = this
    const chain = ffi.llama.sampler_chain_init(ffi.llama.sampler_chain_default_params())
    ffi.llama.sampler_chain_add(chain, ffi.llama.sampler_init_greedy())
    // token 缓冲区必须常驻：batch 里存的是它的指针，不能是临时数组
    const tokenBuf = koffi.alloc('int32_t', 512)
    const pieceBuf = Buffer.alloc(512)
    let text = ''
    try {
      for (let i = 0; i < MAX_TOKENS; i++) {
        const token = ffi.llama.sampler_sample(chain, this.ctx, -1)
        if (ffi.llama.vocab_is_eog(this.vocab, token)) break
        ffi.llama.sampler_accept(chain, token)
        const n = ffi.llama.token_to_piece(this.vocab, token, pieceBuf, 512, 0, false)
        if (n > 0) text += pieceBuf.toString('utf8', 0, n)
        koffi.encode(tokenBuf, 0, 'int32_t', token)
        const batch = ffi.llama.batch_get_one(tokenBuf, 1)
        const rc = ffi.llama.decode(this.ctx, batch)
        if (rc !== 0) throw new Error(`解码失败 (rc=${rc})`)
      }
    } finally {
      ffi.llama.sampler_free(chain)
    }
    return text
  }

  /** 释放模型与上下文 */
  close(): void {
    try {
      this.ffi.mtmd.free(this.mtmdCtx)
      this.ffi.llama.free(this.ctx)
      this.ffi.llama.model_free(this.model)
      this.ffi.llama.backend_free()
    } catch {
      // 释放失败不影响进程退出
    }
  }
}
