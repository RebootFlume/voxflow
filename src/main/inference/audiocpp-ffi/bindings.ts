/**
 * audio.cpp C ABI 的 koffi 绑定层：**只声明 ABI，不含推理逻辑**。
 *
 * 与 llama-ffi / sherpa-ffi 的 bindings 同一层语义：
 * - 结构体布局 = ABI，必须与 `include/audiocpp.h` 严格一致（字段顺序不能改）。
 * - 换 audio.cpp 版本时只需要改这一个文件；ABI 版本由 `audiocpp_abi_version()` 断言。
 *
 * 两个关键点：
 * 1. 句柄一律 `koffi.pointer(koffi.opaque())` —— 写成 `'void *'` 会报
 *    `Cannot pass ambiguous value to void *, use koffi.as()`。
 * 2. DLL 依赖（vcomp140 / msvcp140 等）靠 PATH 找，所以 libs 目录要插到 PATH 最前。
 */

import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import koffi from 'koffi'

const C = 'const char *'

/** 不透明句柄（registry / model / session / request / result 共用） */
export type Handle = unknown

/** 句柄类型：opaque 指针 */
const handle = koffi.pointer(koffi.opaque())

/* ------------------------------------------------------------------ *
 * 结构体（顺序 = ABI，见 include/audiocpp.h）
 * ------------------------------------------------------------------ */

/** 模型选择：四个字段都可为 NULL（family_hint = NULL 时按路径自动识别） */
const modelConfig = koffi.struct('AudiocppModelConfig', {
  family_hint: C,
  config_id: C,
  weight_id: C,
  model_spec_override: C
})

/** 后端选择：backend = "cpu"/"cuda"/"vulkan"/…，NULL 等价 "cpu" */
const backendConfig = koffi.struct('AudiocppBackendConfig', {
  backend: C,
  device: 'int',
  threads: 'int'
})

export interface AudiocppModelConfigInput {
  familyHint: string | null
  configId?: string | null
  weightId?: string | null
  specOverride?: string | null
}

export interface AudiocppBackendConfigInput {
  backend: string
  device?: number
  threads?: number
}

/** 期望的 ABI 主版本（audiocpp_abi_version()：0xMMmmpp，v0.9.4 实测 512 = 0x0200） */
export const REQUIRED_ABI = 0x0200

export interface AudiocppAudio {
  samples: Float32Array
  frames: number
  sampleRate: number
  channels: number
}

export interface AudiocppFfi {
  /** ABI 版本（0xMMmmpp） */
  abi_version(): number
  /** 构建版本字符串（如 "0.9.4"） */
  build_version(): string
  /** 最近一次错误（无错误返回空串） */
  last_error(): string
  /** 状态码 → 文案 */
  status_string(status: number): string

  /** 创建模型注册表（config_path = null 时用内置 loader） */
  registry_create(): Handle
  registry_free(registry: Handle): void

  /** 加载模型 */
  model_load(registry: Handle, modelPath: string, config: AudiocppModelConfigInput): Handle
  model_free(model: Handle): void
  model_family(model: Handle): string
  /** 模型是否支持某 task/mode（1 = 支持） */
  model_supports(model: Handle, task: string, mode: string): number
  /** 模型声明的语言列表 */
  model_languages(model: Handle): string[]

  /** 创建会话（task = "tts"/"asr"/…；mode = "offline"/"streaming"） */
  session_create(
    model: Handle,
    task: string,
    mode: string,
    backend: AudiocppBackendConfigInput
  ): Handle
  session_free(session: Handle): void

  /** 创建请求 */
  request_create(): Handle
  request_free(request: Handle): void
  /** 设置文本（language 可为 null） */
  request_set_text(request: Handle, text: string, language: string | null): void
  /** 设置音频（交错 float PCM；frames = **每声道**帧数） */
  request_set_audio(
    request: Handle,
    samples: Float32Array,
    frames: number,
    sampleRate: number,
    channels: number
  ): void
  /** 设置请求级选项（对应 CLI 的 --request-option） */
  request_set_option(request: Handle, key: string, value: string): void

  /** 执行一次离线推理，返回 result 句柄 */
  session_run(session: Handle, request: Handle): Handle
  result_free(result: Handle): void
  /** 读结果音频（交错浮点 PCM；无音频返回 null） */
  result_audio(result: Handle): AudiocppAudio | null
  /** 读结果文本（ASR/对齐等任务；无文本返回空串） */
  result_text(result: Handle): string
}

/** 抛出 C 侧最近一次错误（调用方已确认状态码非 0） */
function fail(
  read: { last_error(): string; status_string(status: number): string },
  status: number,
  what: string
): never {
  const detail = read.last_error() || read.status_string(status) || `status=${status}`
  throw new Error(`audio.cpp ${what}失败：${detail}`)
}

/**
 * 加载 audio.cpp 运行时并完成 FFI 绑定。
 *
 * @param runtimeDir audio.cpp 运行时根目录（<libs>/audio-cpp，含 libs/audiocpp.dll）
 */
export function loadAudiocppFfi(runtimeDir: string): AudiocppFfi {
  const libDir = join(runtimeDir, 'libs')
  const dllPath = join(libDir, 'audiocpp.dll')
  if (!existsSync(dllPath)) {
    throw new Error(`audio.cpp 推理框架未安装: ${dllPath}`)
  }

  // 依赖 DLL（msvcp140 / vcomp140…）靠 PATH 找
  const path = process.env.PATH ?? ''
  if (!path.includes(libDir)) {
    process.env.PATH = `${libDir}${delimiter}${path}`
  }

  const lib = koffi.load(dllPath)

  // 模块化 ggml 的变体（CUDA 包）必须显式注册后端：
  // audiocpp 内部只调 ggml_backend_load_all()，它只在自己进程 exe 旁边找
  // ggml-cuda.dll —— 我们是 electron.exe 进程，那里没有 → session_create 会报
  // "CUDA backend requested but it is not registered in this build"。
  // 与 llama-ffi/session.ts 同一做法：按路径加载后端目录。
  const ggmlPath = join(libDir, 'ggml.dll')
  if (existsSync(ggmlPath)) {
    const ggml = koffi.load(ggmlPath)
    const loadAllFromPath = ggml.func('ggml_backend_load_all_from_path', 'void', [C])
    loadAllFromPath(libDir)
  }

  const abiVersion = lib.func('audiocpp_abi_version', 'uint32_t', [])
  const buildVersion = lib.func('audiocpp_build_version', C, [])
  const lastError = lib.func('audiocpp_last_error', C, [])
  const statusString = lib.func('audiocpp_status_string', C, ['int32_t'])

  const registryCreate = lib.func('audiocpp_registry_create', 'int32_t', [
    C,
    koffi.out(koffi.pointer(handle))
  ])
  const registryFree = lib.func('audiocpp_registry_free', 'void', [handle])

  const modelLoad = lib.func('audiocpp_model_load', 'int32_t', [
    handle,
    C,
    koffi.pointer(modelConfig),
    koffi.pointer('void'),
    koffi.out(koffi.pointer(handle))
  ])
  const modelFree = lib.func('audiocpp_model_free', 'void', [handle])
  const modelFamily = lib.func('audiocpp_model_family', C, [handle])
  const modelSupports = lib.func('audiocpp_model_supports', 'int', [handle, C, C])
  const modelLanguageCount = lib.func('audiocpp_model_language_count', 'size_t', [handle])
  const modelLanguage = lib.func('audiocpp_model_language', 'int32_t', [
    handle,
    'size_t',
    koffi.out(koffi.pointer('char *'))
  ])

  const sessionCreate = lib.func('audiocpp_session_create', 'int32_t', [
    handle,
    C,
    C,
    koffi.pointer(backendConfig),
    koffi.pointer('void'),
    koffi.out(koffi.pointer(handle))
  ])
  const sessionFree = lib.func('audiocpp_session_free', 'void', [handle])

  const requestCreate = lib.func('audiocpp_request_create', handle, [])
  const requestFree = lib.func('audiocpp_request_free', 'void', [handle])
  const requestSetText = lib.func('audiocpp_request_set_text', 'int32_t', [handle, C, C])
  const requestSetAudio = lib.func('audiocpp_request_set_audio', 'int32_t', [
    handle,
    koffi.pointer('float'),
    'size_t',
    'int',
    'int'
  ])
  const requestSetOption = lib.func('audiocpp_request_set_option', 'int32_t', [handle, C, C])

  const sessionRun = lib.func('audiocpp_session_run', 'int32_t', [
    handle,
    handle,
    koffi.out(koffi.pointer(handle))
  ])
  const resultFree = lib.func('audiocpp_result_free', 'void', [handle])
  const resultAudio = lib.func('audiocpp_result_audio', 'int32_t', [
    handle,
    koffi.out(koffi.pointer('const float *')),
    koffi.out(koffi.pointer('size_t')),
    koffi.out(koffi.pointer('int')),
    koffi.out(koffi.pointer('int'))
  ])
  const resultText = lib.func('audiocpp_result_text', 'int32_t', [
    handle,
    koffi.out(koffi.pointer('char *')),
    koffi.out(koffi.pointer('char *'))
  ])

  const reader = {
    last_error: (): string => String(lastError() ?? ''),
    status_string: (status: number): string => String(statusString(status) ?? '')
  }

  const abi = Number(abiVersion())
  if (abi !== REQUIRED_ABI) {
    throw new Error(
      `audio.cpp ABI 不匹配：期望 0x${REQUIRED_ABI.toString(16)}，实际 0x${abi.toString(16)}`
    )
  }

  return {
    abi_version: () => abi,
    build_version: () => String(buildVersion() ?? ''),
    ...reader,

    registry_create: (): Handle => {
      const out: unknown[] = [null]
      const status = Number(registryCreate(null, out))
      if (status !== 0) fail(reader, status, '创建模型注册表')
      return out[0]
    },
    registry_free: (registry) => registryFree(registry),

    model_load: (registry, modelPath, config) => {
      const out: unknown[] = [null]
      const cfg = {
        family_hint: config.familyHint,
        config_id: config.configId ?? null,
        weight_id: config.weightId ?? null,
        model_spec_override: config.specOverride ?? null
      }
      const status = Number(modelLoad(registry, modelPath, cfg, null, out))
      if (status !== 0) fail(reader, status, '加载模型')
      return out[0]
    },
    model_free: (model) => modelFree(model),
    model_family: (model) => String(modelFamily(model) ?? ''),
    model_supports: (model, task, mode) => Number(modelSupports(model, task, mode)),
    model_languages: (model) => {
      const count = Number(modelLanguageCount(model))
      const languages: string[] = []
      for (let i = 0; i < count; i++) {
        const out: unknown[] = [null]
        const status = Number(modelLanguage(model, i, out))
        if (status !== 0) break
        if (out[0]) languages.push(String(out[0]))
      }
      return languages
    },

    session_create: (model, task, mode, backend) => {
      const out: unknown[] = [null]
      const cfg = {
        backend: backend.backend,
        device: backend.device ?? 0,
        threads: backend.threads ?? 4
      }
      const status = Number(sessionCreate(model, task, mode, cfg, null, out))
      if (status !== 0) fail(reader, status, '创建会话')
      return out[0]
    },
    session_free: (session) => sessionFree(session),

    request_create: (): Handle => requestCreate(),
    request_free: (request) => requestFree(request),
    request_set_text: (request, text, language) => {
      const status = Number(requestSetText(request, text, language))
      if (status !== 0) fail(reader, status, '设置请求文本')
    },
    request_set_audio: (request, samples, frames, sampleRate, channels) => {
      const status = Number(requestSetAudio(request, samples, frames, sampleRate, channels))
      if (status !== 0) fail(reader, status, '设置请求音频')
    },
    request_set_option: (request, key, value) => {
      const status = Number(requestSetOption(request, key, value))
      if (status !== 0) fail(reader, status, `设置请求选项 ${key}`)
    },

    session_run: (session, request) => {
      const out: unknown[] = [null]
      const status = Number(sessionRun(session, request, out))
      if (status !== 0) fail(reader, status, '推理')
      return out[0]
    },
    result_free: (result) => resultFree(result),
    result_audio: (result) => {
      const samples: unknown[] = [null]
      const frames: unknown[] = [0]
      const rate: unknown[] = [0]
      const channels: unknown[] = [0]
      const status = Number(resultAudio(result, samples, frames, rate, channels))
      if (status !== 0) return null
      const n = Number(frames[0] ?? 0)
      const ch = Number(channels[0] ?? 0) || 1
      if (!samples[0] || n <= 0) return null
      const decoded = koffi.decode(samples[0], 'float', n * ch) as Float32Array
      return {
        samples: Float32Array.from(decoded),
        frames: n,
        sampleRate: Number(rate[0] ?? 0),
        channels: ch
      }
    },
    result_text: (result) => {
      const text: unknown[] = [null]
      const lang: unknown[] = [null]
      const status = Number(resultText(result, text, lang))
      if (status !== 0) return ''
      return text[0] ? String(text[0]) : ''
    }
  }
}
