/**
 * koffi FFI 绑定层：**只声明 C API，不含任何推理逻辑**。
 *
 * 为什么要单独一层：会话层（session.ts）关心的是「怎么把音频变成文本」，
 * 而「函数签名长什么样、参数怎么摆、结构体字段顺序」是纯粹的 ABI 细节。
 * 两者分开后，换 llama.cpp 版本时只需要改这一个文件。
 *
 * 结构体布局对应 llama.cpp **tag b12211**（随包 DLL 的版本号 `b12211`）。
 * 字段顺序/类型必须与 `include/llama.h` 严格一致，否则会读到错位的值。
 */

import { delimiter, join } from 'node:path'
import koffi from 'koffi'

const voidPtr = 'void *'
const voidPtrPtr = koffi.pointer(koffi.pointer('void'))

/** llama_model_params（b12211） */
export const llamaModelParams = koffi.struct('llama_model_params', {
  devices: voidPtrPtr,
  tensor_buft_overrides: voidPtrPtr,
  n_gpu_layers: 'int32_t',
  split_mode: 'int32_t',
  load_mode: 'int32_t',
  /** b12211 新增：enum llama_lazy_mode（位置在 load_mode 之后，不是末尾） */
  lazy_mode: 'int32_t',
  main_gpu: 'int32_t',
  tensor_split: koffi.pointer('float'),
  progress_callback: voidPtr,
  progress_callback_user_data: voidPtr,
  kv_overrides: voidPtrPtr,
  vocab_only: 'bool',
  check_tensors: 'bool',
  use_extra_bufts: 'bool',
  no_host: 'bool',
  no_alloc: 'bool',
  load_mtp: 'bool'
})

/** llama_context_params（b12211） */
export const llamaContextParams = koffi.struct('llama_context_params', {
  n_ctx: 'uint32_t',
  n_batch: 'uint32_t',
  n_ubatch: 'uint32_t',
  n_seq_max: 'uint32_t',
  n_rs_seq: 'uint32_t',
  n_outputs_max: 'uint32_t',
  n_outputs_max_per_seq: 'uint32_t',
  n_threads: 'int32_t',
  n_threads_batch: 'int32_t',
  ctx_type: 'int32_t',
  rope_scaling_type: 'int32_t',
  pooling_type: 'int32_t',
  attention_type: 'int32_t',
  flash_attn_type: 'int32_t',
  rope_freq_base: 'float',
  rope_freq_scale: 'float',
  yarn_ext_factor: 'float',
  yarn_attn_factor: 'float',
  yarn_beta_fast: 'float',
  yarn_beta_slow: 'float',
  yarn_orig_ctx: 'uint32_t',
  defrag_thold: 'float',
  cb_eval: voidPtr,
  cb_eval_user_data: voidPtr,
  type_k: 'int32_t',
  type_v: 'int32_t',
  /** b12211 新增：MoE 专家缓存（位置在 type_v 之后） */
  moe_cache_size: 'size_t',
  moe_cache_cpu_share: 'float',
  abort_callback: voidPtr,
  abort_callback_data: voidPtr,
  embeddings: 'bool',
  offload_kqv: 'bool',
  no_perf: 'bool',
  op_offload: 'bool',
  swa_full: 'bool',
  kv_unified: 'bool',
  samplers: voidPtr,
  n_samplers: 'size_t',
  ctx_other: voidPtr
})

/** llama_batch */
export const llamaBatch = koffi.struct('llama_batch', {
  n_tokens: 'int32_t',
  token: koffi.pointer('int32_t'),
  embd: koffi.pointer('float'),
  pos: koffi.pointer('int32_t'),
  n_seq_id: koffi.pointer('int32_t'),
  seq_id: koffi.pointer(koffi.pointer('int32_t')),
  logits: koffi.pointer('int8_t')
})

/** llama_sampler_chain_params */
export const llamaSamplerChainParams = koffi.struct('llama_sampler_chain_params', {
  no_perf: 'bool'
})

/** mtmd_context_params */
export const mtmdContextParams = koffi.struct('mtmd_context_params', {
  use_gpu: 'bool',
  device: voidPtr,
  print_timings: 'bool',
  n_threads: 'int32_t',
  image_marker: 'const char *',
  media_marker: 'const char *',
  flash_attn_type: 'int32_t',
  warmup: 'bool',
  image_min_tokens: 'int32_t',
  image_max_tokens: 'int32_t',
  cb_eval: voidPtr,
  cb_eval_user_data: voidPtr,
  batch_max_tokens: 'int32_t',
  progress_callback: voidPtr,
  progress_callback_user_data: voidPtr
})

/** mtmd_input_text */
export const mtmdInputText = koffi.struct('mtmd_input_text', {
  text: 'const char *',
  text_len: 'size_t',
  add_special: 'bool',
  parse_special: 'bool'
})

/** mtmd_caps */
export const mtmdCaps = koffi.struct('mtmd_caps', {
  inp_vision: 'bool',
  inp_audio: 'bool',
  /** b12211 新增 */
  gen_audio: 'bool'
})

/** mtmd_helper_bitmap_wrapper */
export const mtmdBitmapWrapper = koffi.struct('mtmd_helper_bitmap_wrapper', {
  bitmap: voidPtr,
  video_ctx: voidPtr
})

/** 不透明句柄（模型 / 上下文 / 采样器 / mtmd 上下文 …） */
export type Handle = unknown

export interface LlamaApi {
  backend_init: () => void
  backend_free: () => void
  model_default_params: () => any
  model_load_from_file: (path: string, params: any) => Handle
  model_free: (model: Handle) => void
  model_size: (model: Handle) => number
  model_get_vocab: (model: Handle) => Handle
  model_n_embd: (model: Handle) => number
  context_default_params: () => any
  init_from_model: (model: Handle, params: any) => Handle
  free: (ctx: Handle) => void
  get_memory: (ctx: Handle) => Handle
  memory_clear: (mem: Handle, data: boolean) => void
  memory_seq_pos_max: (mem: Handle, seq: number) => number
  batch_get_one: (tokens: unknown, n: number) => any
  batch_free: (batch: any) => void
  decode: (ctx: Handle, batch: any) => number
  vocab_n_tokens: (vocab: Handle) => number
  vocab_is_eog: (vocab: Handle, token: number) => boolean
  vocab_eos: (vocab: Handle) => number
  token_to_piece: (
    vocab: Handle,
    token: number,
    buf: Buffer,
    length: number,
    lstrip: number,
    special: boolean
  ) => number
  sampler_chain_default_params: () => any
  sampler_chain_init: (params: any) => Handle
  sampler_chain_add: (chain: Handle, sampler: Handle) => void
  sampler_init_greedy: () => Handle
  sampler_init_temp: (temp: number) => Handle
  sampler_sample: (chain: Handle, ctx: Handle, idx: number) => number
  sampler_accept: (chain: Handle, token: number) => void
  /** 释放采样器（sampler chain 本身也是一个 sampler，用它释放即可） */
  sampler_free: (sampler: Handle) => void
}

export interface MtmdApi {
  context_params_default: () => any
  init_from_file: (mmproj: string, model: Handle, params: any) => Handle
  free: (ctx: Handle) => void
  get_cap_from_file: (path: string) => { inp_vision: boolean; inp_audio: boolean }
  helper_bitmap_init_from_buf: (
    ctx: Handle,
    buf: Buffer,
    len: number,
    placeholder: boolean
  ) => { bitmap: Handle; video_ctx: Handle }
  bitmap_free: (bitmap: Handle) => void
  tokenize: (
    ctx: Handle,
    chunks: unknown,
    text: any,
    bitmaps: unknown,
    nBitmaps: number
  ) => number
  input_chunks_init: () => Handle
  input_chunks_free: (chunks: Handle) => void
  input_chunks_size: (chunks: Handle) => number
  helper_get_n_tokens: (chunks: Handle) => number
  helper_eval_chunks: (
    ctx: Handle,
    lctx: Handle,
    chunks: Handle,
    nPast: number,
    seqId: number,
    nBatch: number,
    logitsLast: boolean,
    newPast: Buffer
  ) => number
}

export interface GgmlApi {
  backend_load_all_from_path: (path: string) => void
  backend_dev_count: () => number
  backend_dev_get: (index: number) => Handle
  /** 按名字取设备（如 "CUDA0"）；不存在 → null */
  backend_dev_by_name: (name: string) => Handle | null
  /** 读设备显存（字节）：free / total 各写一个 8 字节缓冲 */
  backend_dev_memory: (dev: Handle, free: Buffer, total: Buffer) => void
}

export interface LlamaFfi {
  llama: LlamaApi
  mtmd: MtmdApi
  ggml: GgmlApi
  /** 卸载全部动态库（进程退出时用） */
  unload(): void
}

/**
 * 加载运行时动态库并完成 FFI 绑定。
 *
 * 两个关键点（都踩过坑）：
 * 1. 依赖 DLL（cublas/cudnn 等）靠 **PATH** 找，所以必须先把 libs 目录插到 PATH 最前。
 * 2. 动态后端（ggml-cuda.dll）按 **exe 所在目录** 找，`ggml_backend_load_all()` 在
 *    其它进程里会找不到后端，必须用 `ggml_backend_load_all_from_path(libsDir)`。
 */
export function loadLlamaFfi(libsDir: string): LlamaFfi {
  if (!process.env.PATH?.includes(libsDir)) {
    process.env.PATH = `${libsDir}${delimiter}${process.env.PATH ?? ''}`
  }

  // 加载顺序有依赖关系：ggml-base → ggml → llama → mtmd
  const ggmlBase = koffi.load(join(libsDir, 'ggml-base.dll'))
  const ggmlLib = koffi.load(join(libsDir, 'ggml.dll'))
  const llamaLib = koffi.load(join(libsDir, 'llama.dll'))
  const mtmdLib = koffi.load(join(libsDir, 'mtmd.dll'))
  void ggmlBase

  const llama: LlamaApi = {
    backend_init: llamaLib.func('llama_backend_init', 'void', []),
    backend_free: llamaLib.func('llama_backend_free', 'void', []),
    model_default_params: llamaLib.func('llama_model_default_params', llamaModelParams, []),
    model_load_from_file: llamaLib.func(
      'llama_model_load_from_file',
      voidPtr,
      ['const char *', llamaModelParams]
    ),
    model_free: llamaLib.func('llama_model_free', 'void', [voidPtr]),
    model_size: llamaLib.func('llama_model_size', 'uint64_t', [voidPtr]),
    model_get_vocab: llamaLib.func('llama_model_get_vocab', voidPtr, [voidPtr]),
    model_n_embd: llamaLib.func('llama_model_n_embd', 'int32_t', [voidPtr]),
    context_default_params: llamaLib.func('llama_context_default_params', llamaContextParams, []),
    init_from_model: llamaLib.func('llama_init_from_model', voidPtr, [voidPtr, llamaContextParams]),
    free: llamaLib.func('llama_free', 'void', [voidPtr]),
    get_memory: llamaLib.func('llama_get_memory', voidPtr, [voidPtr]),
    memory_clear: llamaLib.func('llama_memory_clear', 'void', [voidPtr, 'bool']),
    memory_seq_pos_max: llamaLib.func('llama_memory_seq_pos_max', 'int32_t', [voidPtr, 'int32_t']),
    batch_get_one: llamaLib.func(
      'llama_batch_get_one',
      llamaBatch,
      [koffi.pointer('int32_t'), 'int32_t']
    ),
    batch_free: llamaLib.func('llama_batch_free', 'void', [llamaBatch]),
    decode: llamaLib.func('llama_decode', 'int32_t', [voidPtr, llamaBatch]),
    vocab_n_tokens: llamaLib.func('llama_vocab_n_tokens', 'int32_t', [voidPtr]),
    vocab_is_eog: llamaLib.func('llama_vocab_is_eog', 'bool', [voidPtr, 'int32_t']),
    vocab_eos: llamaLib.func('llama_vocab_eos', 'int32_t', [voidPtr]),
    token_to_piece: llamaLib.func(
      'llama_token_to_piece',
      'int32_t',
      [voidPtr, 'int32_t', 'char *', 'int32_t', 'int32_t', 'bool']
    ),
    sampler_chain_default_params: llamaLib.func(
      'llama_sampler_chain_default_params',
      llamaSamplerChainParams,
      []
    ),
    sampler_chain_init: llamaLib.func('llama_sampler_chain_init', voidPtr, [llamaSamplerChainParams]),
    sampler_chain_add: llamaLib.func('llama_sampler_chain_add', voidPtr, [voidPtr, voidPtr]),
    sampler_init_greedy: llamaLib.func('llama_sampler_init_greedy', voidPtr, []),
    sampler_init_temp: llamaLib.func('llama_sampler_init_temp', voidPtr, ['float']),
    sampler_sample: llamaLib.func('llama_sampler_sample', 'int32_t', [voidPtr, voidPtr, 'int32_t']),
    sampler_accept: llamaLib.func('llama_sampler_accept', 'void', [voidPtr, 'int32_t']),
    sampler_free: llamaLib.func('llama_sampler_free', 'void', [voidPtr])
  }

  const mtmd: MtmdApi = {
    context_params_default: mtmdLib.func('mtmd_context_params_default', mtmdContextParams, []),
    init_from_file: mtmdLib.func('mtmd_init_from_file', voidPtr, [
      'const char *',
      voidPtr,
      mtmdContextParams
    ]),
    free: mtmdLib.func('mtmd_free', 'void', [voidPtr]),
    get_cap_from_file: mtmdLib.func('mtmd_get_cap_from_file', mtmdCaps, ['const char *']),
    helper_bitmap_init_from_buf: mtmdLib.func(
      'mtmd_helper_bitmap_init_from_buf',
      mtmdBitmapWrapper,
      [voidPtr, 'const unsigned char *', 'size_t', 'bool']
    ),
    bitmap_free: mtmdLib.func('mtmd_bitmap_free', 'void', [voidPtr]),
    tokenize: mtmdLib.func('mtmd_tokenize', 'int32_t', [
      voidPtr,
      voidPtr,
      mtmdInputText,
      koffi.pointer(koffi.pointer('void')),
      'size_t'
    ]),
    input_chunks_init: mtmdLib.func('mtmd_input_chunks_init', voidPtr, []),
    input_chunks_free: mtmdLib.func('mtmd_input_chunks_free', 'void', [voidPtr]),
    input_chunks_size: mtmdLib.func('mtmd_input_chunks_size', 'size_t', [voidPtr]),
    helper_get_n_tokens: mtmdLib.func('mtmd_helper_get_n_tokens', 'size_t', [voidPtr]),
    helper_eval_chunks: mtmdLib.func('mtmd_helper_eval_chunks', 'int32_t', [
      voidPtr,
      voidPtr,
      voidPtr,
      'int32_t',
      'int32_t',
      'int32_t',
      'bool',
      'int32_t *'
    ])
  }

  const ggml: GgmlApi = {
    backend_load_all_from_path: ggmlLib.func('ggml_backend_load_all_from_path', 'void', [
      'const char *'
    ]),
    backend_dev_count: ggmlLib.func('ggml_backend_dev_count', 'size_t', []),
    backend_dev_get: ggmlLib.func('ggml_backend_dev_get', voidPtr, ['int32_t']),
    backend_dev_by_name: ggmlLib.func('ggml_backend_dev_by_name', voidPtr, ['const char *']),
    backend_dev_memory: ggmlBase.func('ggml_backend_dev_memory', 'void', [
      voidPtr,
      'void *',
      'void *'
    ])
  }

  return {
    llama,
    mtmd,
    ggml,
    unload: () => {
      llamaLib.unload()
      mtmdLib.unload()
      ggmlLib.unload()
      ggmlBase.unload()
    }
  }
}
