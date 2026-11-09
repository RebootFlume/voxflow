/**
 * 推理框架运行时（libs/）的下载与校验
 * —— 对齐 Rust 版 `src-tauri/src/inference/runtime_download.rs`。
 *
 * 逻辑：
 *  1. 下载：主包、附件各用同一 `netDownload`（断点续传 + 重试 + 原子落盘）
 *  2. 解压：两者各用同一 `extractArchive`，解到独立临时目录
 *  3. 落位：`placeExtracted` —— 解压结果若只有一层 wrapper 目录则剥掉，
 *     内容放进目标目录。主包 → target 根；附件 → target/auxDir（"" = 根）
 *  4. 完整性校验（marker + auxFiles）+ 试启动
 *
 * 参数与就绪判定全部来自 `RUNTIME_PACKAGES` 数据表，本模块无框架分支。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { emitSidecar } from '../core/events'
import { log } from '../core/logger'
import { extractArchiveAsync } from '../core/extract'
import { libsDir } from './runtime-paths'
import {
  freeBytesForDir,
  getProxy,
  headSize,
  netDownload,
  parseProxy,
  urlSuffix,
  type CancelFlag
} from '../models/model-manager'

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
  /** 运行时包下载键（必须唯一；例如 onnx / gguf） */
  framework: string
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
  /** 版本（展示用；与 url / innerDir 中的版本号人工保持一致，改动时三处同改） */
  version: string
  /** 运行时包 SHA-256；空字符串表示未固定校验值 */
  sha256: string
  /** 附加包 SHA-256 */
  auxSha256: string
  /** 解压后占用字节数（磁盘预检用；null = 按归档大小估算） */
  unpackedBytes: number | null
  /** 下载包中必须存在且可解析的 manifest 相对路径 */
  manifest: string | null
  /** GitHub release 资产 URL（下载地址） */
  url: string
  /** 附加依赖包 URL（如 llama.cpp 官方把 CUDA 运行库拆成独立的 cudart-*.zip） */
  auxUrl: string | null
  /** aux 包内容解压到的目标子目录（相对 targetDir，"" = 根目录） */
  auxDir: string
  /** 完整性校验文件（解压后必须存在，缺失 = 包不完整/需要修复） */
  auxFiles: string[]
  /** 压缩包内顶层目录名（解压后要移出的子目录） */
  innerDir: string
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
 * - audio.cpp: v0.9.4（cpu / cuda 两个变体，各自独立目录与版本戳）
 */
export const RUNTIME_PACKAGES: RuntimePkg[] = [
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
    manifest: null,
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12211/llama-b12211-bin-win-cuda-12.4-x64.zip',
    auxUrl:
      'https://github.com/ggml-org/llama.cpp/releases/download/b12211/cudart-llama-bin-win-cuda-12.4-x64.zip',
    auxDir: '',
    auxFiles: ['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll'],
    // b12211 起官方 zip 改为平铺（不再有 llama-bXXXX-... 这层 wrapper 目录）
    innerDir: '',
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
    manifest: null,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda.tar.bz2',
    auxUrl: SHERPA_CUDA_AUX_URL,
    auxDir: 'bin',
    auxFiles: SHERPA_CUDA_AUX_FILES,
    innerDir: 'sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda',
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
  // 代价是设备选择与安装状态产生必然失败的组合（只装 CPU 包 + 选 CUDA 设备 =
  // RUNTIME_VARIANT_MISMATCH），且变体概念要贯穿 UI、身份与错误文案。
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
    manifest: null,
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
    innerDir: '',
    targetDir: 'audio-cpp',
    marker: 'libs/audiocpp.dll',
    portBase: 0,
    smokeArgs: [],
    smokeProbe: { type: 'skip' }
  }
]

/** libs 根目录（exe 旁 libs/，便携与安装共用） */
export function libsRoot(): string {
  return libsDir()
}

/** 某框架的运行时目录（与推理启动同一路径解析） */
export function runtimeDirFor(pkg: RuntimePkg): string {
  const found = RUNTIME_PACKAGES.find((p) => p.framework === pkg.framework)
  return join(libsRoot(), found ? found.targetDir : pkg.targetDir)
}

/** 递归把 src 目录合并进 dest（同名覆盖），用于旧变体目录迁移 */
function mergeDirInto(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, e.name)
    const to = join(dest, e.name)
    if (e.isDirectory()) {
      mergeDirInto(from, to)
    } else {
      rmSync(to, { force: true })
      renameSync(from, to)
    }
  }
}

/**
 * 旧版把 audio.cpp 拆成 cpu / cuda 两个包（libs/audio-cpp + libs/audio-cpp-cuda）。
 * 现在只有一个全功能包，装在 libs/audio-cpp —— 启动时把旧的 CUDA 目录合并进来，
 * 已装用户不必重新下载 2GB。
 *
 * 合并方向固定为「CUDA → 主目录」：CUDA 包包含 CPU 包的全部能力（自带 ggml-cpu-*），
 * 反过来的话只装过 CPU 包的用户会缺 ggml-cuda.dll。
 */
export function migrateLegacyAudiocppRuntime(): string[] {
  const legacy = join(libsDir(), 'audio-cpp-cuda')
  if (!existsSync(legacy)) return []
  const target = join(libsDir(), 'audio-cpp')
  try {
    mergeDirInto(legacy, target)
    rmSync(legacy, { recursive: true, force: true })
    return [legacy]
  } catch (e) {
    log.warn(`[framework] audio.cpp 旧变体目录合并失败: ${String(e)}`)
    return []
  }
}

/** manifest 是否匹配（构建工具会写 UTF-8 BOM，先剥掉） */
function runtimeManifestMatches(pkg: RuntimePkg, path: string): boolean {
  try {
    const raw = readFileSync(path, 'utf-8').replace(/^\uFEFF/, '')
    const value = JSON.parse(raw) as Record<string, unknown>
    return (
      value.worker_protocol === 1 &&
      value.variant === pkg.variant &&
      typeof value.torch === 'string' &&
      value.torch.startsWith('2.14.0') &&
      value.script === 'worker.py'
    )
  } catch {
    return false
  }
}

/**
 * 安装版本戳：解压完成后写入 pkg.version。
 *
 * 为什么需要它：绑定层（koffi 结构体布局）是**按某个具体版本**写的，
 * 运行时 DLL 与绑定不匹配时会静默读出错位字段（甚至崩溃）。
 * 只靠 marker 存在无法区分 b10622 / b12211，升级后会误用旧 DLL。
 */
const INSTALLED_VERSION_FILE = '.installed-version'

/** 读取已安装版本戳（老安装没有这个文件 → null） */
export function installedRuntimeVersion(pkg: RuntimePkg): string | null {
  try {
    return readFileSync(join(runtimeDirFor(pkg), INSTALLED_VERSION_FILE), 'utf-8').trim() || null
  } catch {
    return null
  }
}

/**
 * 检测框架是否已安装（与推理启动共用同一路径解析：能找到启动 exe = 已下载）。
 * 同时校验 auxFiles（如 CUDA 运行库）完整 —— 主程序在但运行库缺失 = 未完成安装，
 * 前端据此显示"需要修复/重新下载"（否则 CUDA 会静默回退 CPU）。
 */
export function isRuntimeInstalled(pkg: RuntimePkg): boolean {
  const dir = runtimeDirFor(pkg)
  if (!existsSync(join(dir, pkg.marker))) return false
  // 版本戳不匹配 = 装的是旧版 DLL，与当前绑定层结构体不一致 → 视为未安装（提示重新下载）
  if (installedRuntimeVersion(pkg) !== pkg.version) return false
  if (pkg.manifest && !runtimeManifestMatches(pkg, join(dir, pkg.manifest))) return false
  return pkg.auxFiles.every((f) => existsSync(join(dir, f)))
}

/** missing = 主程序都未下载 */
export function runtimeDiagnose(pkg: RuntimePkg): { state: string; missing: string[] } {
  const dir = runtimeDirFor(pkg)
  if (!existsSync(join(dir, pkg.marker))) {
    return { state: 'missing', missing: [pkg.marker] }
  }
  const missing = pkg.auxFiles.filter((f) => !existsSync(join(dir, f)))
  if (installedRuntimeVersion(pkg) !== pkg.version) {
    // 版本不符时提示可读原因（与缺失文件列在同一处展示）
    missing.push(`${INSTALLED_VERSION_FILE}（已装版本不符，需 ${pkg.version}）`)
  }
  if (pkg.manifest && !runtimeManifestMatches(pkg, join(dir, pkg.manifest))) {
    missing.push(pkg.manifest)
  }
  return missing.length === 0 ? { state: 'ready', missing: [] } : { state: 'incomplete', missing }
}

/** 检测所有框架状态（供前端展示）——三态：ready / incomplete / missing */
export function runtimeStatus(): {
  status: string
  root: string
  packages: {
    framework: string
    engine: string
    name: string
    variant: string
    supports_cpu: boolean
    supports_cuda: boolean
    version: string
    installed: boolean
    state: string
    missing: string[]
    dir: string
  }[]
} {
  return {
    status: 'runtime_status',
    root: libsRoot(),
    packages: RUNTIME_PACKAGES.map((p) => {
      const { state, missing } = runtimeDiagnose(p)
      return {
        framework: p.framework,
        engine: p.engine,
        name: p.name,
        variant: p.variant,
        supports_cpu: p.supportsCpu,
        supports_cuda: p.supportsCuda,
        version: p.version,
        installed: state === 'ready',
        state,
        missing,
        dir: runtimeDirFor(p)
      }
    })
  }
}

/** 单框架诊断 JSON（纯文件检查，不触发下载/启动） */
export function runtimeDiagnoseJson(framework: string): {
  state: string
  installed: boolean
  missing: string[]
  dir: string
} {
  const pkg = RUNTIME_PACKAGES.find((p) => p.framework === framework)
  if (!pkg) return { state: 'missing', installed: false, missing: [], dir: '' }
  const { state, missing } = runtimeDiagnose(pkg)
  return { state, installed: state === 'ready', missing, dir: runtimeDirFor(pkg) }
}

/** 选择已安装且支持目标设备的运行时包 */
export function installedRuntimeForDevice(engine: string, device: string): RuntimePkg | null {
  const wantsCuda = ['cuda', 'gpu'].includes(device.trim().toLowerCase())
  const candidates = RUNTIME_PACKAGES.filter(
    (p) =>
      p.engine === engine &&
      (wantsCuda ? p.supportsCuda : p.supportsCpu) &&
      isRuntimeInstalled(p)
  )
  return candidates[0] ?? null
}

/** audio.cpp 运行时包（唯一包；CPU / CUDA 共用同一份）。 */
export function audiocppPackage(): RuntimePkg | undefined {
  return RUNTIME_PACKAGES.find((p) => p.engine === 'audiocpp')
}

/** audio.cpp 运行时选择结果 */
export interface AudiocppRuntimeChoice {
  pkg: RuntimePkg
  dir: string
  /** 传给 C 侧的后端名（"cpu" / "cuda"） */
  backend: 'cpu' | 'cuda'
}

/**
 * audio.cpp 运行时选择：只有一个包，装没装才是唯一的失败条件。
 *
 * 设备只决定传给 C 侧的后端名 —— CPU 与 CUDA 由同一个包里不同的 ggml 后端承担
 * （包内同时含 ggml-cpu-*.dll 与 ggml-cuda.dll）。
 *
 * - 未安装 → 明确提示去「推理框架」页下载；
 * - 机器没有 N 卡却选了 cuda → 后端降为 cpu（本来也跑不了 GPU），不报错。
 */
export function audiocppRuntimeForDevice(
  device: string,
  gpuAvailable: boolean
): AudiocppRuntimeChoice {
  const pkg = audiocppPackage()
  if (!pkg || !isRuntimeInstalled(pkg)) {
    throw new Error('audio.cpp 推理框架未安装：请到「推理框架」页下载 audio.cpp')
  }
  const wantsCuda = ['cuda', 'gpu'].includes(device.trim().toLowerCase())
  return {
    pkg,
    dir: runtimeDirFor(pkg),
    backend: wantsCuda && gpuAvailable ? 'cuda' : 'cpu'
  }
}

/** 返回适合目标设备的默认下载包（已安装包优先，避免切换设备时重复下载） */
export function preferredRuntimeForDevice(engine: string, device: string): RuntimePkg | null {
  const installed = installedRuntimeForDevice(engine, device)
  if (installed) return installed
  const wantsCuda = ['cuda', 'gpu'].includes(device.trim().toLowerCase())
  return (
    RUNTIME_PACKAGES.find(
      (p) => p.engine === engine && (wantsCuda ? p.supportsCuda : p.supportsCpu)
    ) ?? null
  )
}

// ── 下载 ────────────────────────────────────────────────────────────────────

/** 下载中的框架（framework → 取消标志）；同一框架同时只允许一个下载 */
const activeRuntime = new Map<string, CancelFlag>()

/** 请求取消正在进行的运行时下载 */
export function requestCancelRuntime(framework: string): boolean {
  const flag = activeRuntime.get(framework)
  if (!flag) return false
  flag.cancelled = true
  return true
}

/** 取远程文件大小（HEAD 优先；走显式代理，与下载同一条链路） */
async function httpSize(url: string, proxy: URL | null): Promise<number | null> {
  return headSize(url, proxy)
}

/** 下载单文件，进度映射到全局区间 [spanStart, spanEnd] */
async function downloadToFile(
  url: string,
  framework: string,
  label: string,
  out: string,
  spanStart: number,
  spanEnd: number,
  cancel: CancelFlag,
  proxy: URL | null
): Promise<void> {
  log.info(`[framework] 下载${label}: ${url.slice(url.lastIndexOf('/') + 1)}`)
  await netDownload({
    url,
    dest: out,
    proxy,
    cancel,
    onProgress: (downloaded, total) => {
      const pct =
        total && total > 0
          ? spanStart + Math.floor(((spanEnd - spanStart) * downloaded) / total)
          : spanStart
      emitSidecar({
        status: 'runtime_download_progress',
        framework,
        progress: pct,
        downloaded,
        total: total ?? 0
      })
    }
  })
}

/** 校验归档 SHA-256（期望值为空则跳过） */
function verifyArchiveSha256(path: string, expected: string): void {
  if (!expected) return
  const hash = createHash('sha256')
  const buf = readFileSync(path)
  hash.update(buf)
  const actual = hash.digest('hex')
  if (actual !== expected) {
    throw new Error(`归档校验失败（期望 ${expected}，实际 ${actual}）`)
  }
}

/** 把解压产物放进目标目录：若只有一层 wrapper 目录（官方包常见）则剥掉 */
function placeExtracted(src: string, dest: string): void {
  const entries = readdirSync(src, { withFileTypes: true })
  const singleDir = entries.length === 1 && entries[0].isDirectory()
  const from = singleDir ? readdirSync(join(src, entries[0].name), { withFileTypes: true }) : entries
  if (from.length === 0) {
    throw new Error(`解压结果为空: ${src}`)
  }
  for (const e of from) {
    const target = join(dest, e.name)
    try {
      renameSync(join(src, e.name), target)
    } catch {
      // 跨卷 rename 失败 → 复制
      rmSync(target, { force: true, recursive: true })
      renameSync(join(src, e.name), target)
    }
  }
}
// ── 归档解压 ──────────────────────────────────────────────────────────────
//
// 解压统一走共享的异步实现（core/extract.ts）：Rust 版用同步 Command 解压，
// 移植到 Electron 后会占住主线程 ⇒ 渲染进程收不到 IPC ⇒ 窗口「未响应」被系统判 AppHang。
// 这里改成 spawn + Promise，解压期间主线程照常服务 IPC。


/**
 * 试启动验证框架（不带模型）。
 * 目的：确认 exe + DLL 链能真正启动（文件在 ≠ 能跑；缺 DLL 会秒退/无法加载）。
 */
export async function smokeTestRuntime(pkg: RuntimePkg): Promise<void> {
  // 纯 DLL 包没有可执行入口，跳过试启动（DLL 链在引擎首次加载时自证）
  if (pkg.smokeProbe.type === 'skip') return
  const dir = runtimeDirFor(pkg)
  const exe = join(dir, pkg.marker)
  if (!existsSync(exe)) {
    throw new Error(`${exe} 不存在`)
  }

  // 随机端口（避开默认 8931/9002 与已运行实例冲突；基线来自数据表的 portBase）
  const port = 20000 + (process.pid % 1000) + pkg.portBase
  const portArg = String(port)
  const args = pkg.smokeArgs.map((a) => (a === '$PORT' ? portArg : a))
  // 取出判别联合到局部常量：闭包内 TS 无法对属性访问做窄化
  const probe = pkg.smokeProbe
  const healthPath = probe.type === 'httpHealth' ? probe.path : null
  const stderrKeywords = probe.type === 'stderrKeywords' ? probe.keywords : null

  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    const stderrChunks: Buffer[] = []
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c))

    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearInterval(timer)
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      fn()
    }

    const timer = setInterval(() => {
      if (child.exitCode !== null) {
        finish(() => {
          const stderrText = Buffer.concat(stderrChunks).toString('utf-8')
          if (stderrKeywords) {
            const hit = stderrKeywords.some((kw) => stderrText.includes(kw))
            if (hit) {
              resolve()
            } else {
              reject(
                new Error(
                  `sherpa 启动未通过：退出=${child.exitCode}，stderr: ${stderrText.trim()}`
                )
              )
            }
          } else {
            reject(new Error(`试启动进程提前退出（exit=${child.exitCode}）`))
          }
        })
        return
      }
      if (healthPath) {
        void fetch(`http://127.0.0.1:${port}${healthPath}`, {
          signal: AbortSignal.timeout(800)
        })
          .then((res) => {
            if (res.ok) {
              finish(() => resolve())
            }
          })
          .catch((e: unknown) => {
            log.warn(
              `[framework] 健康探测失败（${port}${healthPath}）: ${
                e instanceof Error ? e.message : String(e)
              }`
            )
          })
      }
    }, 300)

    // 就绪判定上限。
    // Rust 版是 6s —— 但首次下载完冷缓存时，llama-server 要先加载 ~550MB CUDA DLL
    // 才能 listen（>6s），会误判成"DLL 缺失"。这里放宽到 15s：
    // 判定语义不变（起不来仍失败），只是不给冷启动留假阴性。
    setTimeout(() => {
      finish(() => {
        const stderrText = Buffer.concat(stderrChunks).toString('utf-8')
        reject(new Error(`llama 15 秒内未就绪（端口 ${port}），stderr: ${stderrText.trim()}`))
      })
    }, 15000)
  })
}

/**
 * 两步验证（供「验证」按钮与下载完成共用）：
 *   ① 文件检查：marker + auxFiles 缺一 → incomplete + 缺失清单
 *   ② 试启动：DLL 链能否真跑
 */
export async function verifyRuntimeFull(framework: string): Promise<{
  state: string
  installed: boolean
  missing: string[]
  error: string
  dir: string
}> {
  const pkg = RUNTIME_PACKAGES.find((p) => p.framework === framework)
  if (!pkg) return { state: 'missing', installed: false, missing: [], error: '', dir: '' }

  const { state, missing } = runtimeDiagnose(pkg)
  if (state !== 'ready') {
    return {
      state,
      installed: false,
      missing,
      error: '',
      dir: runtimeDirFor(pkg)
    }
  }
  try {
    await smokeTestRuntime(pkg)
    return { state: 'ready', installed: true, missing: [], error: '', dir: runtimeDirFor(pkg) }
  } catch (e) {
    return {
      state: 'error',
      installed: false,
      missing: [],
      error: e instanceof Error ? e.message : String(e),
      dir: runtimeDirFor(pkg)
    }
  }
}

/**
 * 下载并安装推理框架运行时。
 *
 * 主包与附件一视同仁：各自下载 → 各自解压到独立临时目录 → 各自落位
 * （主包 → target 根；附件 → target/auxDir）。
 */
export async function downloadRuntime(framework: string): Promise<void> {
  const pkg = RUNTIME_PACKAGES.find((p) => p.framework === framework)
  if (!pkg) throw new Error(`unknown framework: ${framework}`)

  if (isRuntimeInstalled(pkg)) return // 已安装（含 aux 运行库校验）

  // 取消注册（任意返回路径自动摘除）；同一框架同时只允许一个下载
  if (activeRuntime.has(pkg.framework)) {
    throw new Error(`${pkg.name} 运行时正在下载中`)
  }
  const cancel: CancelFlag = { cancelled: false }
  activeRuntime.set(pkg.framework, cancel)

  const dest = runtimeDirFor(pkg)
  const root = join(dest, '..')
  try {
    mkdirSync(root, { recursive: true })
  } catch (e) {
    activeRuntime.delete(pkg.framework)
    throw new Error(`create libs dir: ${e instanceof Error ? e.message : String(e)}`)
  }
  // 临时目录（dest 同级，同卷 rename 原子）
  const tmp = join(dest, '..', `_runtime_${pkg.framework}`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })

  try {
    log.info(`[framework] 开始下载 ${pkg.name} 运行时（主包 + 附件）`)

    const mainArch = join(tmp, `main.${urlSuffix(pkg.url)}`)
    const auxArch = pkg.auxUrl ? join(tmp, `aux.${urlSuffix(pkg.auxUrl)}`) : null

    // 大小只用于进度权重：探测失败不阻断下载
    const proxy = parseProxy(getProxy())
    const mainSize = await httpSize(pkg.url, proxy)
    const auxSize = pkg.auxUrl ? await httpSize(pkg.auxUrl, proxy) : null
    const merged = mainSize !== null && (pkg.auxUrl === null || auxSize !== null)
    if (!merged) {
      log.warn(`[framework] ${pkg.name} 大小探测失败：进度条按主包单包区间显示`)
    }
    const total = (mainSize ?? 0) + (auxSize ?? 0)
    const mainEnd = merged && total > 0 ? Math.floor(((mainSize ?? 0) / total) * 100) : 100

    // 磁盘预检：归档与解压产物在解压期间并存 = 下载量 + 解压量
    const downloaded = (mainSize ?? 0) + (auxSize ?? 0)
    const need = downloaded + (pkg.unpackedBytes ?? downloaded)
    if (need > 0) {
      const free = await freeBytesForDir(root)
      if (free !== null && free < need) {
        throw new Error(
          `磁盘空间不足：需要约 ${(need / 1024 ** 3).toFixed(1)}GB，剩余 ${(free / 1024 ** 3).toFixed(1)}GB`
        )
      }
    }

    await downloadToFile(pkg.url, pkg.framework, '主包', mainArch, 0, mainEnd, cancel, proxy)
    verifyArchiveSha256(mainArch, pkg.sha256)
    if (auxArch && pkg.auxUrl) {
      const [s, e] = merged ? [mainEnd, 100] : [100, 100]
      await downloadToFile(pkg.auxUrl, pkg.framework, '附加运行库', auxArch, s, e, cancel, proxy)
      verifyArchiveSha256(auxArch, pkg.auxSha256)
    }

    // 解压（主包/附件独立目录；解压无进度，发「解压中」状态防 UI 假卡死）
    emitSidecar({ status: 'runtime_download_phase', framework, phase: 'extracting' })
    log.info(`[framework] 下载完成，开始解压 ${pkg.name}（大包需 1-2 分钟）`)

    const mainX = join(tmp, 'main_x')
    mkdirSync(mainX, { recursive: true })
    log.info('[framework] 解压主程序包...')
    try {
      await extractArchiveAsync(mainArch, mainX)
    } catch (e) {
      throw new Error(`解压主程序失败: ${e instanceof Error ? e.message : String(e)}`)
    }
    rmSync(mainArch, { force: true })

    const auxX = auxArch ? join(tmp, 'aux_x') : null
    if (auxX && auxArch) {
      mkdirSync(auxX, { recursive: true })
      log.info('[framework] 解压附加运行库包...')
      try {
        await extractArchiveAsync(auxArch, auxX)
      } catch (e) {
        throw new Error(`解压附加运行库失败: ${e instanceof Error ? e.message : String(e)}`)
      }
      rmSync(auxArch, { force: true })
    }

    // 落位：清空目标，主包内容 → dest；附件内容 → dest/auxDir
    log.info(`[framework] 文件落位到 ${dest}`)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    placeExtracted(mainX, dest)
    if (auxX) {
      const auxTarget = pkg.auxDir ? join(dest, pkg.auxDir) : dest
      mkdirSync(auxTarget, { recursive: true })
      placeExtracted(auxX, auxTarget)
    }
    rmSync(tmp, { recursive: true, force: true })

    // 写入版本戳（必须在校验之前，校验会读它）
    writeFileSync(join(dest, INSTALLED_VERSION_FILE), `${pkg.version}\n`, 'utf-8')

    // 完整性校验：marker + auxFiles 全部存在
    if (!isRuntimeInstalled(pkg)) {
      const missing = [pkg.marker, ...pkg.auxFiles].filter(
        (f) => !existsSync(join(runtimeDirFor(pkg), f))
      )
      throw new Error(
        `解压后完整性校验失败，缺失文件: ${missing.join(', ')}（包可能不完整，或官方资产结构变化）`
      )
    }

    // 试启动验证（marker 存在 ≠ 能跑；缺 DLL 时 spawn 即失败/秒退）
    if (pkg.smokeProbe.type === 'skip') {
      log.info('[framework] 纯 DLL 包，跳过试启动（由引擎首次加载验证）')
    } else {
      log.info('[framework] 完整性校验通过，试启动引擎验证 DLL 链...')
      try {
        await smokeTestRuntime(pkg)
      } catch (e) {
        throw new Error(
          `试启动验证失败（可能 DLL 缺失）：${e instanceof Error ? e.message : String(e)}`
        )
      }
      log.info(`[framework] ${pkg.name} 试启动通过`)
    }

    emitSidecar({ status: 'runtime_installed', framework: pkg.framework })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const cancelled = msg.includes('__CANCELLED__')
    emitSidecar({
      status: cancelled ? 'runtime_download_cancelled' : 'runtime_download_error',
      framework: pkg.framework,
      msg
    })
    throw e
  } finally {
    activeRuntime.delete(pkg.framework)
  }
}

/** 目标目录大小（字节） */
export function runtimeDirSize(dir: string): number {
  try {
    return statSync(dir).isDirectory() ? dirSize(dir) : 0
  } catch {
    return 0
  }
}

function dirSize(dir: string): number {
  let total = 0
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) total += dirSize(p)
      else if (e.isFile()) total += statSync(p).size
    }
  } catch {
    /* 忽略不可读项 */
  }
  return total
}
