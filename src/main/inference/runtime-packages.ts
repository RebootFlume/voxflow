/**
 * 运行时包的**数据表** —— 与下载逻辑分离，供 runtime-paths 等只读消费方引用。
 *
 * 为什么拆出来：runtime-paths 需要 `targetDir` 来拼 `libs/<dir>`，而 runtime-download
 * 需要 `libsDir()` —— 放在同一文件会形成循环 import。数据表零依赖，谁都能引。
 */

import type { RuntimeKey } from '../../shared/framework-ids'

/** 试启动就绪判定方式（数据驱动：新增框架只加一条数据行 + 一个变体值，不改函数） */
export type SmokeProbe =
  /** 起进程后轮询 HTTP 健康端点，成功即就绪 */
  | { type: 'httpHealth'; path: string }
  /** 无服务端点：等进程退出且 stderr 命中任一关键词（= exe+DLL 链完好） */
  | { type: 'stderrKeywords'; keywords: string[] }
  /** 纯 DLL 包（没有可执行入口）：装完即视为可用，由引擎首次使用时验证 */
  | { type: 'skip' }

/** libs 压缩包发布信息（GitHub release 资产名 + 版本） */
export interface RuntimePkg {
  /**
   * 运行时包下载键（必须唯一；例如 onnx / gguf）。
   * 类型来自 framework-ids 的全量词表 —— 写错的键在这里就编译不过。
   */
  framework: RuntimeKey
  /** 引擎注册键（同一引擎可有多套运行时包，按设备选择） */
  engine: string
  /** 展示名 */
  name: string
  /** 运行时变体（同一引擎的多个包用；缺省空字符串） */
  variant: string
  /** 是否支持 CPU 推理 */
  supportsCpu: boolean
  /** 是否支持 CUDA 推理 */
  supportsCuda: boolean
  /** 版本（展示用；与 url 中的版本号人工保持一致） */
  version: string
  /** 运行时包 SHA-256；空字符串表示未固定校验值 */
  sha256: string
  /** 附加包 SHA-256 */
  auxSha256: string
  /** 解压后占用字节数（磁盘预检用；null = 按归档大小估算） */
  unpackedBytes: number | null
  /** GitHub release 资产 URL（下载地址） */
  url: string
  /** 附加依赖包 URL（如 llama.cpp 官方把 CUDA 运行库拆成独立的 cudart-*.zip） */
  auxUrl: string | null
  /** aux 包内容解压到的目标子目录（相对 targetDir，"" = 根目录） */
  auxDir: string
  /** 完整性校验文件（解压后必须存在，缺失 = 包不完整/需要修复） */
  auxFiles: string[]
  /** 目标目录名（解压到 libs/ 下） */
  targetDir: string
  /** 校验文件（存在即认为已安装） */
  marker: string
  /** 试启动随机端口基线 */
  portBase: number
  /** 试启动参数（`$PORT` 占位符在运行时替换为实际端口） */
  smokeArgs: string[]
  /** 试启动就绪判定方式 */
  smokeProbe: SmokeProbe
}

/**
 * sherpa-onnx 自带的 CUDA 运行库资产（我们发布，固定版本）：
 * cudnn9×8 + cufft11×2 + cudart64_12/cublas64_12/cublasLt64_12 = 13 个 dll（打进 bin/）。
 * 官方 sherpa 包不含 NVIDIA 库，缺失会导致 CUDA EP 静默失败 → 必须随 sherpa 一起装。
 */
export const SHERPA_CUDA_AUX_URL =
  'https://github.com/RebootFlume/voxflow/releases/download/runtime-assets/voxflow-sherpa-cuda12-runtime.zip'

export const SHERPA_CUDA_AUX_FILES = [
  'bin/cudart64_12.dll',
  'bin/cublas64_12.dll',
  'bin/cublasLt64_12.dll',
  'bin/cudnn64_9.dll',
  'bin/cudnn_adv64_9.dll',
  'bin/cudnn_cnn64_9.dll',
  'bin/cudnn_engines_precompiled64_9.dll',
  'bin/cudnn_engines_runtime_compiled64_9.dll',
  'bin/cudnn_graph64_9.dll',
  'bin/cudnn_heuristic64_9.dll',
  'bin/cudnn_ops64_9.dll',
  'bin/cufft64_11.dll',
  'bin/cufftw64_11.dll',
  // TTS 工具也必须在（与 ASR 的 websocket server 同层 bin/）：
  // 只校验 ASR exe 会让"缺 TTS exe"的包显示为已安装，TTS 首次合成才失败。
  'bin/sherpa-onnx-offline-tts.exe'
]


/**
 * 当前发布包（官方版本，固定版本号）
 * - llama.cpp: b12211（cuda-12.4）
 *   注意：官方 cuda 版拆成两个 zip —— 主程序包 + cudart 运行库包（cudart64/cublas）。
 *   必须两个都下载，否则 CUDA 后端加载失败会【静默回退 CPU】。
 * - sherpa-onnx: v2.0.1（cuda-12.x-cudnn-9.x, onnxruntime 1.28.2）
 * - audio.cpp: v0.9.4（官方发布 cpu / cuda 两个变体，本项目只取 cuda 全功能包）
 */
export const RUNTIME_PACKAGES = [
  {
    framework: 'gguf',
    engine: 'gguf',
    variant: '',
    supportsCpu: true,
    supportsCuda: true,
    name: 'llama.cpp',
    version: 'b12211',
    sha256: '',
    auxSha256: '',
    unpackedBytes: null,
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12211/llama-b12211-bin-win-cuda-12.4-x64.zip',
    auxUrl:
      'https://github.com/ggml-org/llama.cpp/releases/download/b12211/cudart-llama-bin-win-cuda-12.4-x64.zip',
    auxDir: '',
    auxFiles: ['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll'],
    // b12211 起官方 zip 改为平铺（不再有 llama-bXXXX-... 这层 wrapper 目录）
    targetDir: 'llama-cpp',
    // marker 仍是 llama-server.exe：老版本已经用它判过「运行时已安装」，
    // 换成 llama.dll 会让存量安装被判成缺失、重新下载 1GB。包里两者都有，marker 只是证据。
    marker: 'llama-server.exe',
    portBase: 0,
    smokeArgs: ['--port', '$PORT', '--no-webui'],
    smokeProbe: { type: 'httpHealth', path: '/health' }
  },
  {
    framework: 'onnx',
    engine: 'onnx',
    variant: '',
    supportsCpu: true,
    supportsCuda: true,
    name: 'sherpa-onnx',
    version: 'v2.0.1',
    sha256: '',
    auxSha256: '',
    unpackedBytes: null,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda.tar.bz2',
    auxUrl: SHERPA_CUDA_AUX_URL,
    auxDir: 'bin',
    auxFiles: SHERPA_CUDA_AUX_FILES,
    targetDir: 'sherpa-onnx',
    marker: 'bin/sherpa-onnx-offline-websocket-server.exe',
    portBase: 50,
    smokeArgs: ['--port', '$PORT'],
    smokeProbe: {
      type: 'stderrKeywords',
      keywords: [
        'does not exist',
        'recognizer config',
        'Invalid integer option',
        'tokens:',
        'ParseOptions',
        'parse-options'
      ]
    }
  },
  // audio.cpp: 单一包。官方发布 CPU / CUDA 两个变体，但 CUDA 包本身带全套
  // ggml-cpu-*.dll，既能跑 CUDA 也能跑 CPU —— 两个包只是"省 1.97GB 下载"的差别，
  // 代价是设备选择与安装状态产生必然失败的组合（只装 CPU 包 + 选 CUDA 设备），
  // 且变体概念要贯穿 UI、身份与错误文案 —— 已于上一轮整体移除。
  // 定案：只留全功能包，装到 libs/audio-cpp，设备切换纯运行时行为。
  {
    framework: 'audiocpp',
    engine: 'audiocpp',
    variant: '',
    supportsCpu: true,
    supportsCuda: true,
    name: 'audio.cpp',
    version: 'v0.9.4',
    sha256: '',
    auxSha256: '',
    unpackedBytes: null,
    // 模块化 ggml：ggml.dll / ggml-base.dll / ggml-cuda.dll 都在 libs/，
    // 且默认不注册 GPU 后端 —— 必须由 bindings 显式 ggml_backend_load_all_from_path。
    url: 'https://github.com/0xShug0/audio.cpp/releases/download/v0.9.4/audio-v0.9.4-lib-windows-x64-cuda12.4.zip',
    // NVIDIA 运行库单独发布（4 个 dll 在 zip 根目录），解到 libs/ 与 audiocpp.dll 同级
    auxUrl:
      'https://github.com/0xShug0/audio.cpp/releases/download/v0.9.4/audio-v0.9.4-cudart-windows-x64-cuda12.4.zip',
    auxDir: 'libs',
    auxFiles: [
      'libs/cudart64_12.dll',
      'libs/cublas64_12.dll',
      'libs/cublasLt64_12.dll',
      'libs/cufft64_11.dll'
    ],
    targetDir: 'audio-cpp',
    marker: 'libs/audiocpp.dll',
    portBase: 0,
    smokeArgs: [],
    smokeProbe: { type: 'skip' }
  }
] satisfies readonly RuntimePkg[]

/**
 * 编译期断言：RUNTIME_KEYS 里的每个键都必须有对应数据行。
 *
 * 效果 = 在 framework-ids 里加一个包键却不加数据行时，下面这行赋值失败（'never' 不可赋值）。
 * 这是本表唯一的自动化保护 —— 之前它只是一个 `string[]`，漏一行只会表现为
 * 「运行时页少一个包」这种不会报错的空条目。
 */
// 注意必须用 satisfies 而不是 `: RuntimePkg[]` —— 类型注解会把字面量拓宽成整个
// RuntimeKey 联合，Exclude 退化成 never，断言就永远不会报错（等于没写）。
type UncoveredRuntimeKeys = Exclude<RuntimeKey, (typeof RUNTIME_PACKAGES)[number]['framework']>
const assertEveryRuntimeKeyHasPackage: [UncoveredRuntimeKeys] extends [never] ? true : UncoveredRuntimeKeys = true
void assertEveryRuntimeKeyHasPackage
