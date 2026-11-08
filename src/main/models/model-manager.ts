/**
 * 模型管理器 —— 模型下载 / 清单 / 删除
 *
 * ── 对齐 Rust 版 `src-tauri/src/model_manager.rs`（1:1 移植；注释译为中文并保留原意）──
 *
 * - 下载：统一走本模块的 `netDownload`（流式 + 断点续传 + 原子 + 取消 + 重试）
 *   · GitHub release 资产：整包下载后解压
 *   · HuggingFace：按模型的**精选条目**（`DownloadEntry.files` 精确文件名）逐个直链下载
 * - 代理：**显式**使用配置里的 proxy，不写进程环境变量。
 *   实测（本机）：reqwest **默认就会读** `HTTP(S)_PROXY`（与 `system-proxy` feature 无关），
 *   显式代理优先于 env；但 env 的 `no_proxy=127.0.0.1` 会把回环从**显式**代理里也排除掉，
 *   同进程内的 env 变更会互相污染（测试实测到过）。
 *   ⇒ 统一改为：显式代理 + 回环硬豁免（`LOOPBACK_NO_PROXY`）+ 启动时把 env 代理"接管"进配置
 *   再清空 env（见 `adoptProxyEnv`），从此不再依赖任何隐式行为。
 * - 旧机制（已删除）：~~写入 HTTP(S)_PROXY + NO_PROXY=localhost,127.0.0.1；`ENV_SCOPE_LOCK` 保证
 *   「写环境变量 + 建 client」原子化，避免并发建 Client 的竞态
 * - Token：仅来自 config.json 的 huggingfaceToken，且**只发 huggingface.co**
 * - 记账：下载完成写 `.voxflow-manifest.json`（条目 id + repo@revision + 文件与大小）
 */

import { execFile } from 'node:child_process'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { Agent as HttpAgent, request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { connect as netConnect, type Socket } from 'node:net'
import { basename, dirname, isAbsolute, join, parse as parsePath } from 'node:path'
import type { Duplex, Readable } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'
import { promisify } from 'node:util'

import { defaultModelRoot, getDataRoot } from '../core/data-root'
import { extractArchiveAsync } from '../core/extract'
import { emitSidecar } from '../core/events'
import { log } from '../core/logger'
import { estimateVramMb, gpuMemMb, readGgufKvGeometryCached, setFrameworkGpuSources } from '../inference/vram'
import {
  SPECS,
  type DownloadEntrySpec,
  type DownloadSourceSpec,
  type EntryFileSpec,
  type ModelSpec,
  type VoiceModeSpec
} from './spec-data'

// ── 注册表（对策 python-backend/voxflow/registry.py） ──

/** 主模型文件挑选策略 */
export type FilePolicy = 'largest' | 'preferUnquantized'

/**
 * 框架描述符（引擎级元数据：文件发现 / 显存诊断）
 *
 * **新增推理框架 = 加一条数据 + 实现引擎 + 注册一行**，不再需要改任何 match 分支。
 * `id` 是引擎注册键（与 `ModelSpec.framework`、registry 注册行一致）。
 */
export interface FrameworkSpec {
  /** 引擎注册键："gguf" | "onnx" | "sherpa" */
  id: string
  /** 前端展示名（分组 / 标签 / 显存 JSON key）："llama" | "sherpa" | "torch" */
  engine: string
  /** 运行时包键（RUNTIME_PACKAGES.framework）："gguf" | "onnx" */
  runtimeKey: string
  /** 主模型文件扩展名 */
  mainExts: readonly string[]
  filePolicy: FilePolicy
  /** 是否附带 mmproj（llama 的视觉/音频投影塔） */
  usesMmproj: boolean
  /** 显存诊断：常驻进程名（null = 无常驻进程） */
  processName: string | null
}

export const FRAMEWORKS: readonly FrameworkSpec[] = [
  {
    id: 'gguf',
    engine: 'llama',
    runtimeKey: 'gguf',
    mainExts: ['.gguf'],
    filePolicy: 'largest',
    usesMmproj: true,
    // gguf 引擎跑在本软件的 FFI worker 进程里（不是独立 exe），按 PID 归因即可，
    // 没有可按名字匹配的外部进程
    processName: null
  },
  {
    id: 'onnx',
    engine: 'sherpa',
    runtimeKey: 'onnx',
    mainExts: ['.onnx'],
    filePolicy: 'preferUnquantized',
    usesMmproj: false,
    processName: 'sherpa-onnx-offline-websocket-server'
  },
  {
    id: 'sherpa',
    engine: 'sherpa',
    runtimeKey: 'onnx',
    mainExts: ['.onnx'],
    filePolicy: 'preferUnquantized',
    usesMmproj: false,
    // TTS 合成是一次性子进程：无常驻进程可探
    processName: null
  },
  {
    id: 'pytorch',
    engine: 'torch',
    // 名义上的运行时包 key（展示/过滤用）；实际按设备选用 pytorch-cpu 或 pytorch-cuda130，
    // 前端门禁读 models JSON 的 runtime_keys（全部可用包），不靠这一个字段判定。
    runtimeKey: 'pytorch-cpu',
    mainExts: ['.safetensors', '.pth'],
    filePolicy: 'largest',
    usesMmproj: false,
    processName: 'python'
  }
]

// 显存诊断需要「框架 → 常驻进程名」的映射；注入给 vram 模块（避免两模块互相 import 成环）
setFrameworkGpuSources(FRAMEWORKS)

/** 按引擎注册键查框架描述符 */
export function frameworkSpec(id: string): FrameworkSpec | undefined {
  return FRAMEWORKS.find((f) => f.id === id)
}

/** 主模型文件扩展名（未知框架 → 空表，调用方按「未找到」处理） */
export function mainExts(framework: string): readonly string[] {
  return frameworkSpec(framework)?.mainExts ?? []
}

/** 运行时包键（未知框架 → undefined） */
export function runtimeKey(framework: string): string | undefined {
  return frameworkSpec(framework)?.runtimeKey
}

/** 是否附带 mmproj（未知框架 → false） */
export function usesMmproj(framework: string): boolean {
  return frameworkSpec(framework)?.usesMmproj ?? false
}

// ── 运行时配置 ──

interface RuntimeConfig {
  modelRoot: string
  proxy: string
  /** HF 下载 token（config.json 可见可管；空 = 匿名/回退 env） */
  token: string
}

/** 运行时配置（Rust 的 `CONFIG: RwLock<RuntimeConfig>` → 模块级变量） */
let runtimeConfig: RuntimeConfig | null = null

/** 惰性初始化（默认模型根要读 Electron 的数据根，不能在模块加载期求值） */
function config(): RuntimeConfig {
  if (!runtimeConfig) {
    runtimeConfig = { modelRoot: defaultModelRoot(), proxy: '', token: '' }
  }
  return runtimeConfig
}

/**
 * 回环永不走代理：所有本地 HTTP 客户端（sherpa 健康检查/转写/chat）都挂这条规则。
 * 否则用户环境里的 `HTTP_PROXY` 会让 127.0.0.1 的请求绕一圈（实测：curl 走代理时仍返回 200，
 * 但代理一旦不可用，整个 ASR 就挂）。
 */
export const LOOPBACK_NO_PROXY = '127.0.0.1,localhost,::1'

/**
 * 启动时的一次性归一化：把我们进程的代理配置**收敛为唯一来源**。
 *
 * - 配置为空时，接管环境变量里的代理（尊重用户已有的环境设置，不然他的下载会直连失败）；
 * - 随后**清空**所有代理环境变量：留着就会隐式生效，与显式配置打架、并可被 `no_proxy` 的副作用影响（实测踩过）。
 *
 * 返回最终生效的代理（供日志/事件展示）。
 */
export function adoptProxyEnv(): string {
  const cfg = config()
  if (cfg.proxy.trim() === '') {
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
      const v = process.env[k]
      if (v !== undefined && v.trim() !== '') {
        cfg.proxy = v.trim()
        log.info(`[proxy] 配置为空 → 接管环境变量 ${k}`)
        break
      }
    }
  }
  // 与 Rust 版的差异：Rust 在此**删除**代理环境变量，因为 reqwest 会隐式读 env
  // （删掉才能保证「代理只有一个来源」）。Node 内置 fetch / undici **不会**隐式读
  // HTTP_PROXY（除非显式开 NODE_USE_ENV_PROXY），因此本移植**保留**环境变量：
  // 删掉对"单一来源"没有收益，却会连带影响本进程拉起的子进程
  // （sherpa / python worker）与用户的其它期望。
  // 代理仍然只经 `httpFetch(..., proxy)` 显式下发，行为与 Rust 版一致。
  return cfg.proxy
}

/**
 * 设置模型根（运行时配置）。接受：
 *   - 绝对路径（数据根外，用户自选外部目录）→ 原样
 *   - 相对路径（如 "models" / "模型库B"）→ 相对数据根解析为绝对
 * 相对路径禁止 ".." 逃逸（防 config 手改跳出数据根）。无存在性校验（空目录合法）。
 * 返回解析后的绝对路径（调用方用于事件回传/展示）。
 */
export function setModelRoot(path: string): string {
  const p = path.trim()
  if (!p) throw new Error('model root is empty')
  let abs: string
  if (isAbsolute(p)) {
    abs = p
  } else {
    // 相对路径 → 相对数据根解析；".." 逃逸拒绝
    if (p.split(/[\\/]+/).includes('..')) {
      throw new Error(`model root 相对路径禁止 .. 逃逸: ${p}`)
    }
    abs = join(getDataRoot(), p)
  }
  config().modelRoot = abs
  return abs
}

export function setProxy(proxy: string): string {
  const p = proxy.trim()
  config().proxy = p
  return p
}

export function setToken(token: string): string {
  const t = token.trim()
  config().token = t
  return t
}

export function getModelRoot(): string {
  return config().modelRoot
}

export function getProxy(): string {
  return config().proxy
}

/**
 * HF 下载 token：唯一来源 = config.json 的 models.huggingfaceToken（经 bootstrap 进入运行时配置）。
 * 空 = 匿名下载（不设 token）。不读任何环境变量——删除软件无残留，配置只此一处。
 */
export function configToken(): string {
  return config().token.trim()
}

// ── 描述符查找（对齐 Rust `crate::tts::spec::ModelSpec::find`）──

/** 归一化：大小写不敏感 + 去掉 - 和 _（"Kokoro-v1_0" → "kokorov10"） */
function norm(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, '')
}

/**
 * 按别名查找：精确 id > 归一化 id > 归一化目录名（id）> 归一化展示名。
 * 接受前端展示名（Kokoro-v1_0）、引擎 id（kokoro-v1_0）、引擎目录名（kokoro-multi-lang-v1_0）。
 */
export function findSpec(input: string): ModelSpec | undefined {
  // 1. 精确 id / 展示名
  for (const m of SPECS) {
    if (m.id === input || m.name === input) return m
  }
  const inputNorm = norm(input)
  // 2. 归一化 id / 展示名
  for (const m of SPECS) {
    if (norm(m.id) === inputNorm || norm(m.name) === inputNorm) return m
  }
  // 3. 族前缀兜底（最低优先级；唯一性由测试保证）
  const prefix = input.split(/[^\p{L}\p{N}]/u)[0]?.toLowerCase() ?? ''
  if (prefix) {
    for (const m of SPECS) {
      if (norm(m.id).startsWith(prefix)) return m
    }
  }
  return undefined
}

/** 按 id 取精选条目（未知 → undefined） */
export function specEntry(spec: ModelSpec, id: string): DownloadEntrySpec | undefined {
  return spec.entries.find((e) => e.id === id)
}

/** 默认条目（无条目 → null；未标 default 时取第一条） */
export function defaultEntry(spec: ModelSpec): DownloadEntrySpec | null {
  return spec.entries.find((e) => e.default) ?? spec.entries[0] ?? null
}

/**
 * 计算模型下载/查找的目标目录：优先用描述符的引擎目录名（engine_id，
 * 与 TTS 引擎查找一致）；未收录模型回退到展示名目录。
 * 修复「下载到展示名目录但引擎找引擎目录名」的不一致。
 */
export function resolveDownloadDir(root: string, name: string): string {
  // 1. 描述符（TTS 展示名 / 引擎 id / 目录名 归一化匹配）
  const spec = findSpec(name)
  if (spec) return join(root, spec.id)
  return join(root, name)
}

/**
 * 引擎目录（= 描述符的 engine_id 目录名；未收录模型回退展示名）。
 * 引擎侧（llama.cpp FFI / sherpa）查找模型目录时用这个。
 */
export function engineDir(name: string): string {
  const root = getModelRoot()
  const spec = findSpec(name)
  return join(root, spec ? spec.id : name)
}

/** 模型目录（= 下载目录） */
export function modelDir(name: string): string {
  return resolveDownloadDir(getModelRoot(), name)
}

// ── 状态检测 ──

/**
 * 递归查找模型文件（最多 depth 层）
 *
 * 语义对齐 Rust：`DirEntry::metadata()` **不跟随符号链接**，故这里用 `lstatSync`。
 */
export function findModelFiles(dir: string, depth: number, exts: readonly string[]): string[] {
  const found: string[] = []
  if (depth > 2) return found
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return found
  }
  for (const name of entries) {
    const path = join(dir, name)
    let md: ReturnType<typeof lstatSync>
    try {
      md = lstatSync(path)
    } catch {
      continue
    }
    if (md.isFile() && md.size > 1_000_000) {
      const lower = name.toLowerCase()
      if (exts.some((ext) => lower.endsWith(ext))) found.push(path)
    } else if (md.isDirectory() && !name.startsWith('.')) {
      found.push(...findModelFiles(path, depth + 1, exts))
    }
  }
  return found
}

/** 取最大候选（Rust `max_by_key`：并列时取**最后**一个） */
function maxBySize(files: readonly string[]): string | null {
  let best: string | null = null
  let bestSize = 0
  for (const f of files) {
    const size = fileSize(f)
    if (best === null || size >= bestSize) {
      best = f
      bestSize = size
    }
  }
  return best
}

/** 文件字节数（读不到 → 0，对齐 Rust 的 `metadata().map(|m| m.len()).unwrap_or(0)`） */
function fileSize(path: string): number {
  try {
    const st = statSync(path)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

/**
 * 查找主模型文件（策略来自框架描述符：扩展名 / 是否排除 mmproj / 量化偏好）
 *
 * `preferUnquantized`（ONNX）：优先返回 `model.onnx` / `model_fp16.onnx` 等标准模型，
 * 避开 `model_q*` 等 QDQ 量化模型 —— 历史上 `ort 2.0 + onnxruntime 1.28` 加载 Q8F16 QDQ
 * 会 `STATUS_ACCESS_VIOLATION` 崩溃；现虽改走 sherpa CLI，该偏好仍保留。
 */
export function findMainModelFile(dir: string, framework: string): string | null {
  const spec = frameworkSpec(framework)
  if (!spec) return null
  const files = findModelFiles(dir, 0, spec.mainExts)
  if (spec.filePolicy === 'largest') {
    const filtered = files.filter((f) => {
      if (!spec.usesMmproj) return true
      return !basename(f).toLowerCase().includes('mmproj')
    })
    return maxBySize(filtered)
  }
  // preferUnquantized：`_q*` 视为 QDQ 量化
  const isQdq = (p: string): boolean => basename(p).toLowerCase().includes('_q')
  const unquantized = files.filter((p) => !isQdq(p))
  const picked = maxBySize(unquantized)
  if (picked) return picked
  return maxBySize(files)
}

/** 查找 mmproj 文件（GGUF 多模态投影） */
export function findMmprojFile(dir: string): string | null {
  const files = findModelFiles(dir, 0, ['.gguf'])
  for (const f of files) {
    if (basename(f).toLowerCase().includes('mmproj')) return f
  }
  return null
}

/** 文件发现结果缓存项（带目录 mtime 指纹） */
interface DiscoveryCacheEntry {
  mtimeMs: number
  main: string | null
  mmproj: string | null
}

const DISCOVERY_CACHE_LIMIT = 64
const discoveryCache = new Map<string, DiscoveryCacheEntry>()

/**
 * 带缓存的「主模型文件 / mmproj」发现。
 *
 * 为什么缓存：无条目声明时 `findMainModelFile` 要递归列目录并逐个 stat
 * （本机实测 Kokoro 目录 378 个文件 ≈ 50ms、ZipVoice 363 个 ≈ 45ms）。
 * `list_models` 会被启动、模型页刷新、下载完成反复触发，每次都付这个钱
 * ⇒ 点「模型管理」就卡一下。目录 mtime 没变就复用上次结果
 * （增删文件会更新目录 mtime，缓存自然失效）。
 */
function discoveredMainFiles(
  spec: ModelSpec,
  dir: string
): { main: string | null; mmproj: string | null } {
  const key = `${spec.id}|${dir}`
  let mtimeMs: number
  try {
    mtimeMs = statSync(dir).mtimeMs
  } catch {
    return { main: findMainModelFile(dir, spec.framework), mmproj: findMmprojFile(dir) }
  }
  const hit = discoveryCache.get(key)
  if (hit && hit.mtimeMs === mtimeMs) return { main: hit.main, mmproj: hit.mmproj }
  const entry: DiscoveryCacheEntry = {
    mtimeMs,
    main: mainModelFile(spec, dir),
    mmproj: usesMmproj(spec.framework) ? mmprojFile(spec, dir) : null
  }
  if (discoveryCache.size >= DISCOVERY_CACHE_LIMIT) discoveryCache.clear()
  discoveryCache.set(key, entry)
  return { main: entry.main, mmproj: entry.mmproj }
}

/** 检查模型目录是否已下载完成 */
export function isComplete(dir: string): boolean {
  if (!isDir(dir)) return false
  // 检测 1：config.json 存在（PyTorch / GGUF 转换仓库常保留）
  if (existsSync(join(dir, 'config.json'))) return true
  // 检测 2：递归查找模型文件（扩展名来自框架描述符表）
  if (FRAMEWORKS.some((f) => findModelFiles(dir, 0, f.mainExts).length > 0)) return true
  // 检测 3：HF 缓存 blobs（兼容 kokoro 等库自行下载到 hub/models--<name>/blobs/）
  const parent = dirname(dir)
  const hub = join(parent, 'hub')
  const hfName = `models--${basename(dir).replace(/\//g, '--')}`
  const blobs = join(hub, hfName, 'blobs')
  if (isDir(blobs)) {
    try {
      for (const name of readdirSync(blobs)) {
        const st = lstatSync(join(blobs, name))
        if (st.isFile() && st.size > 10 * 1024 * 1024) return true
      }
    } catch {
      // 读不到就当没有
    }
  }
  return false
}

/** 目录是否存在且是目录 */
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 目录递归体积（字节） */
export function dirSizeBytes(dir: string): number {
  let total = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return total
  }
  for (const name of entries) {
    const path = join(dir, name)
    let md: ReturnType<typeof lstatSync>
    try {
      md = lstatSync(path)
    } catch {
      continue
    }
    if (md.isFile()) {
      total += md.size
    } else if (md.isDirectory()) {
      total += dirSizeBytes(path)
    }
  }
  return total
}

/**
 * 「磁盘占用」优先用清单里记录的文件字节数（下载时已逐文件记录）。
 *
 * 清单存在时无需再递归遍历目录 —— 这一步在 `list_models` 里是同步文件 IO，
 * 目录里文件多（sherpa/onnx 包动辄上千个小文件）时会让主线程顿一下。
 * 清单缺失（旧式目录 / 手动拷进来的模型）才回退递归统计。
 */
function onDiskBytes(dir: string): number {
  const m = readManifest(dir)
  if (m && m.files.length > 0) {
    return m.files.reduce((sum, [, size]) => sum + (Number.isFinite(size) ? size : 0), 0)
  }
  return dirSizeBytes(dir)
}

/** 目录体积缓存项（带目录 mtime 指纹：新增/删除文件会更新目录 mtime） */
interface DirSizeCacheEntry {
  mtimeMs: number
  bytes: number
}

const DIR_SIZE_CACHE_LIMIT = 64
const dirSizeCache = new Map<string, DirSizeCacheEntry>()

/**
 * 带缓存的「磁盘占用」。
 *
 * 为什么缓存：旧式目录（没有 manifest）只能递归遍历；本机实测 Kokoro 目录
 * 100ms、ZipVoice 90ms，而 `list_models` 会被启动、模型页刷新、下载完成反复触发
 * —— 每次都同步遍历，点「模型管理」就会明显卡一下。目录 mtime 变了才重算。
 */
function onDiskBytesCached(dir: string): number {
  let mtimeMs: number
  try {
    mtimeMs = statSync(dir).mtimeMs
  } catch {
    return onDiskBytes(dir)
  }
  const hit = dirSizeCache.get(dir)
  if (hit && hit.mtimeMs === mtimeMs) return hit.bytes
  const bytes = onDiskBytes(dir)
  if (dirSizeCache.size >= DIR_SIZE_CACHE_LIMIT) dirSizeCache.clear()
  dirSizeCache.set(dir, { mtimeMs, bytes })
  return bytes
}

/** 取盘符根目录（如 "D:\"） */
function driveRootOf(path: string): string {
  const root = parsePath(path).root
  return root || 'C:\\'
}

/**
 * 指定目录所在卷的可用字节（Windows；其他平台读不到 → null = 不做预检）。
 *
 * Rust 用 Win32 `GetDiskFreeSpaceExW`（freeBytesAvailableToCaller）；
 * Node 的 `fs.statfsSync` 在 Windows 上正是同一口径（bavail × bsize），优先用它；
 * 取不到再退回 PowerShell 的 `[System.IO.DriveInfo]`。
 *
 * 异步返回：PowerShell 兜底曾用 `spawnSync`，最长把 Electron 主线程占住 15s
 * （窗口无响应）；现改为异步执行，调用方 await 即可。
 */
export async function freeBytesForDir(path: string): Promise<number | null> {
  const drive = driveRootOf(path)
  const fast = freeBytesViaStatfs(drive)
  if (fast !== null) return fast
  return freeBytesViaPowerShell(drive)
}

/** statfs 快路径：与 PowerShell 同口径（bavail × bsize），毫秒级，不阻塞主线程 */
function freeBytesViaStatfs(drive: string): number | null {
  try {
    const st = statfsSync(drive)
    const free = Number(st.bavail) * Number(st.bsize)
    if (Number.isFinite(free) && free >= 0) return free
  } catch {
    // 落到 PowerShell 兜底
  }
  return null
}

/**
 * 同步快路径：供不能改成 async 的调用方使用（如 `listModelsPayload`——
 * 它被范围外的 IPC 层同步调用，改 async 会破坏调用契约）。
 * statfs 命中即返回；否则返回兜底缓存值（可能为 null），兜底值由后台任务刷新。
 */
function freeBytesForDirSync(path: string): number | null {
  const drive = driveRootOf(path)
  const fast = freeBytesViaStatfs(drive)
  if (fast !== null) return fast
  const hit = freeBytesCache.get(drive)
  if (hit && Date.now() - hit.at < freeBytesTtlMs(hit.value)) return hit.value
  return null
}

/** 兜底结果的缓存 TTL：成功 30s，失败 5s（失败后尽快能重试） */
const FREE_BYTES_TTL_MS = 30_000
const FREE_BYTES_FAIL_TTL_MS = 5_000
/** 兜底结果缓存：盘符 → { value, at }（避免连续触发时反复起 PowerShell） */
const freeBytesCache = new Map<string, { value: number | null; at: number }>()

function freeBytesTtlMs(value: number | null): number {
  return value === null ? FREE_BYTES_FAIL_TTL_MS : FREE_BYTES_TTL_MS
}

/** execFile 的 Promise 包装（显式标注类型，不用 any） */
const execFileAsync = promisify(execFile) as (
  file: string,
  args: string[],
  options: { encoding: 'utf-8'; windowsHide: boolean; timeout: number }
) => Promise<{ stdout: string; stderr: string }>

/**
 * PowerShell 兜底：可用空间（字节）。
 *
 * 异步执行：`spawnSync` 会把 Electron 主线程占住最长 15s（窗口无响应）；
 * 结果按 TTL 缓存，连续触发时不重复起进程。
 */
async function freeBytesViaPowerShell(drive: string): Promise<number | null> {
  const hit = freeBytesCache.get(drive)
  if (hit && Date.now() - hit.at < freeBytesTtlMs(hit.value)) return hit.value
  const script = `$d = [System.IO.DriveInfo]::new('${drive.replace(/'/g, "''")}'); [int64]$d.AvailableFreeSpace`
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 15000
    })
    const raw = (stdout ?? '').trim()
    const value = /^\d+$/.test(raw) ? Number(raw) : null
    freeBytesCache.set(drive, { value, at: Date.now() })
    return value
  } catch {
    freeBytesCache.set(drive, { value: null, at: Date.now() })
    return null
  }
}

/** 模型根所在卷的可用字节（异步） */
async function freeBytesForRoot(): Promise<number | null> {
  return freeBytesForDir(getModelRoot())
}

/** 模型根所在卷的可用字节（同步快路径；供同步调用方使用） */
function freeBytesForRootSync(): number | null {
  return freeBytesForDirSync(getModelRoot())
}

/**
 * 后台刷新兜底磁盘空间：拿到新值后重发一次模型清单（前端才能看到 disk_free_gb）。
 * 节流 30s；statfs 快路径命中时值不变，不会产生多余事件。
 */
let diskFreeRefreshAt = 0
let diskFreeRefreshInFlight = false
let lastDiskFreeGb: number | null = null

async function refreshDiskFreeInBackground(): Promise<void> {
  const now = Date.now()
  if (diskFreeRefreshInFlight || now - diskFreeRefreshAt < FREE_BYTES_TTL_MS) return
  diskFreeRefreshAt = now
  diskFreeRefreshInFlight = true
  try {
    const bytes = await freeBytesForRoot()
    const gb = bytes === null ? null : Math.round((bytes / 1024 ** 3) * 10) / 10
    if (gb !== lastDiskFreeGb) {
      lastDiskFreeGb = gb
      emitModelsState()
    }
  } catch {
    // 磁盘空间只是展示 / 预检信息，取不到就算了
  } finally {
    diskFreeRefreshInFlight = false
  }
}

// ── 模型目录清单（manifest）："这个目录装的是哪条 + 装了哪些文件"的唯一真源 ──

/** 清单文件名（模型目录内，隐藏文件） */
export const MANIFEST_FILE = '.voxflow-manifest.json'

/** 目录清单（`files` = (相对模型目录的路径, 字节数)） */
export interface Manifest {
  /** 当前安装的精选条目 id */
  entry: string
  repo: string
  revision: string
  /** (相对模型目录的路径, 字节数) */
  files: Array<[string, number]>
}

export function manifestPath(dir: string): string {
  return join(dir, MANIFEST_FILE)
}

/** 读清单（缺失 / 损坏 → null，调用方按旧式目录处理） */
export function readManifest(dir: string): Manifest | null {
  let raw: string
  try {
    raw = readFileSync(manifestPath(dir), 'utf-8')
  } catch {
    return null
  }
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const obj = v as Record<string, unknown>
  const entry = obj['entry']
  if (typeof entry !== 'string') return null
  const rawFiles = obj['files']
  if (!Array.isArray(rawFiles)) return null
  const files: Array<[string, number]> = []
  for (const f of rawFiles) {
    if (typeof f !== 'object' || f === null) continue
    const fo = f as Record<string, unknown>
    const p = fo['path']
    if (typeof p !== 'string') continue
    const size = fo['size']
    files.push([p, typeof size === 'number' && Number.isFinite(size) ? size : 0])
  }
  const repo = obj['repo']
  const revision = obj['revision']
  return {
    entry,
    repo: typeof repo === 'string' ? repo : '',
    revision: typeof revision === 'string' ? revision : '',
    files
  }
}

/** 原子写清单（临时文件 + rename；失败即报错，不留下半个清单） */
export function writeManifest(dir: string, m: Manifest): void {
  const payload = {
    entry: m.entry,
    repo: m.repo,
    revision: m.revision,
    files: m.files.map(([path, size]) => ({ path, size }))
  }
  const tmp = join(dir, `${MANIFEST_FILE}.tmp`)
  const text = JSON.stringify(payload, null, 2)
  try {
    writeFileSync(tmp, text)
  } catch (e) {
    throw new Error(`write manifest: ${(e as Error).message}`)
  }
  try {
    renameSync(tmp, manifestPath(dir))
  } catch (e) {
    throw new Error(`rename manifest: ${(e as Error).message}`)
  }
}

/**
 * 条目显存预估（MiB）：权重 + mmproj **实际字节** + KV（按 ctx 与 GGUF 几何）+ 固定开销。
 *
 * 只有该条目文件**全部在本地**时才算（否则读不到 GGUF 几何、也不知道真实字节数）——
 * 宁可不出这个数字，也不猜。ctx 取 `DEFAULT_CTX_SIZE`（与实际启动参数同一来源）。
 */
export function entryVramEstimateMb(dir: string, entry: DownloadEntrySpec): number | null {
  const main = entry.files.find((f) => f.role === 'main')?.name
  if (!main) return null
  const mainPath = join(dir, main)
  if (!isFile(mainPath)) return null
  let weights = 0
  let mmproj = 0
  for (const f of entry.files) {
    let size: number
    try {
      size = statSync(join(dir, f.name)).size
    } catch {
      return null
    }
    if (f.role === 'mmproj') mmproj += size
    else weights += size
  }
  const geom = readGgufKvGeometryCached(mainPath)
  return estimateVramMb(weights, mmproj, geom, DEFAULT_CTX_SIZE)
}

/** 文件是否存在且是文件 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 该模型当前安装的条目：manifest 优先 → 默认条目（无条目的模型 → null）
 */
export function activeEntryOf(spec: ModelSpec): DownloadEntrySpec | null {
  if (spec.entries.length === 0) return null
  const dir = resolveDownloadDir(getModelRoot(), spec.name)
  const m = readManifest(dir)
  if (m) {
    const e = specEntry(spec, m.entry)
    if (e) return e
  }
  // 旧式目录（无 manifest）：按"文件是否真的在"判定，避免 active 指向未安装的条目
  const def = defaultEntry(spec)
  if (def && entryInstalled(dir, spec, def.id)) return def
  return spec.entries.find((e) => entryInstalled(dir, spec, e.id)) ?? null
}

/** 条目是否已完整落盘：清单声明过的文件按 size 核，未记录 size 的只核存在 */
export function entryInstalled(dir: string, spec: ModelSpec, entryId: string): boolean {
  const entry = specEntry(spec, entryId)
  if (!entry) return false
  if (entry.files.length === 0) return false
  const manifest = readManifest(dir)
  for (const f of entry.files) {
    const path = join(dir, f.name)
    if (!isFile(path)) return false
    if (manifest) {
      const rec = manifest.files.find(([name]) => name === f.name)
      if (rec && rec[1] > 0) {
        const actual = fileSize(path)
        if (actual !== rec[1]) return false
      }
    }
  }
  return true
}

/** 加载端取主文件：条目声明优先 → 退回框架策略（无条目的模型） */
export function mainModelFile(spec: ModelSpec, dir: string): string | null {
  const entry = activeEntryOf(spec)
  if (entry) {
    const name = entry.files.find((f) => f.role === 'main')?.name
    if (name) {
      const path = join(dir, name)
      if (isFile(path)) return path
    }
  }
  return findMainModelFile(dir, spec.framework)
}

/** 加载端取 mmproj：条目声明优先 → 退回旧策略 */
export function mmprojFile(spec: ModelSpec, dir: string): string | null {
  const entry = activeEntryOf(spec)
  if (entry) {
    const name = entry.files.find((f) => f.role === 'mmproj')?.name
    if (name) {
      const path = join(dir, name)
      if (isFile(path)) return path
    }
  }
  return findMmprojFile(dir)
}

// ── HuggingFace 逐文件下载（条目驱动；不用任何 HF 客户端库）──

/**
 * `owner/name` + revision + 仓库内相对路径 → 直链（路径分段百分号编码）
 */
export function hfFileUrl(repo: string, revision: string, name: string): string {
  const encoded = name.split('/').map(encodePathSegment).join('/')
  return `https://huggingface.co/${repo}/resolve/${revision}/${encoded}`
}

/** 路径分段百分号编码（保留 unreserved 与 RFC3986 子分隔符；HF 文件名常见空格/中文） */
function encodePathSegment(seg: string): string {
  const bytes = Buffer.from(seg, 'utf-8')
  let out = ''
  for (const b of bytes) {
    const c = String.fromCharCode(b)
    const keep =
      (c >= 'A' && c <= 'Z') ||
      (c >= 'a' && c <= 'z') ||
      (c >= '0' && c <= '9') ||
      "-_.~()!*'$;,=:@&+".includes(c)
    if (keep) out += c
    else out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/**
 * 是否给该 URL 附 HF token：**只发 huggingface.co**（绝不泄漏给 GitHub 等其他 host）
 */
export function hfAuthHeader(url: string, token: string): [string, string] | null {
  const t = token.trim()
  if (!t || !url.startsWith('https://huggingface.co/')) return null
  return ['Authorization', `Bearer ${t}`]
}

// ── 加载前显存预检 ──

/**
 * 加载前显存预检结论（命令层直接序列化给前端）。
 *
 * 契约（前端弹框文案依赖，勿改）：
 * - `ok = true` ⇒ 直接加载（**包括无法判定**：`checked = false` 时一律放行）
 * - `ok = false` ⇒ 询问用户是否仍要加载，且**当且仅当** `reason == "insufficient"`（显存不足）
 *   其它任何原因（未知模型/文件不全/读不到显存/cpu）都不得返回 `ok = false` —— 预检只是提醒，绝不误拦。
 *
 * 字段名是前后端协议（同 `model_download_progress` 的教训）：改字段必须同步前端 `rustCheckVram`。
 */
export interface VramCheck {
  checked: boolean
  ok: boolean
  need_mb: number | null
  free_mb: number | null
  total_mb: number | null
  used_mb: number | null
  reason: string
}

/** 放行（不判定或无需判定） */
function vramPass(reason: string): VramCheck {
  return {
    checked: false,
    ok: true,
    need_mb: null,
    free_mb: null,
    total_mb: null,
    used_mb: null,
    reason
  }
}

/**
 * 加载前显存预检：该模型上线需要多少 vs 当前可用多少。
 *
 * 需求用与模型页「预计显存」**同一个估算**（权重 + mmproj + KV + 固定开销，见 `vram`），
 * 故此处不再叠加额外余量。任何一环读不到 → fail-open（`ok = true`），由加载失败路径兜底。
 */
export async function checkLoadVram(name: string, device: string): Promise<VramCheck> {
  if (device.trim().toLowerCase() === 'cpu') {
    return vramPass('cpu') // 纯 CPU：不占显存
  }
  const spec = findSpec(name)
  if (!spec) {
    return vramPass('unknown_model') // 交给加载路径报「未知模型」
  }
  const dir = modelDir(name)
  const entry = activeEntryOf(spec)
  if (!entry) {
    return vramPass('need_unknown') // 无条目声明 → 估不出
  }
  const needMb = entryVramEstimateMb(dir, entry)
  if (needMb === null) {
    return vramPass('need_unknown') // 文件不全 → 不猜
  }
  const mem = await gpuMemMb()
  if (!mem) {
    return vramPass('no_vram_info') // 非 NVIDIA / 无权限 → 放行
  }
  const [totalMb, usedMb] = mem
  const freeMb = Math.max(0, totalMb - usedMb)
  const ok = needMb <= freeMb
  return {
    checked: true,
    ok,
    need_mb: needMb,
    free_mb: freeMb,
    total_mb: totalMb,
    used_mb: usedMb,
    reason: ok ? 'ok' : 'insufficient'
  }
}

// ── 清单 payload ──

/**
 * 来源标签（从下载来源推导，不引入第二真源）：
 * `github.com/<owner>/<repo>` 或 `huggingface.co/<owner>/<repo>`。前端直接显示。
 */
export function sourceLabel(source: DownloadSourceSpec): string {
  if (source.type === 'github') {
    const url = source.url ?? ''
    const trimmed = url.replace(/^(https:\/\/)+/, '')
    return trimmed.split('/releases/')[0] ?? url
  }
  return `huggingface.co/${source.repo ?? ''}`
}

/** 语言模式 → 前端字符串（描述符能力字段） */
export function languageModeStr(m: ModelSpec['languageMode']): string {
  switch (m) {
    case 'auto':
      return 'auto'
    case 'fixed':
      return 'fixed'
    case 'select':
      return 'select'
    case 'cloning':
      return 'cloning'
    default:
      return 'fixed'
  }
}

/** 音色模式 → 前端 JSON（描述符能力字段） */
export function voiceModeJson(v: VoiceModeSpec): Record<string, unknown> {
  switch (v.type) {
    case 'fixed':
      return { type: 'fixed' }
    case 'preset':
      return { type: 'preset', count: v.count, per_language: v.perLanguage }
    case 'clone':
      return { type: 'clone', requires_text: v.requiresText, overrides_preset: v.overridesPreset }
    case 'presetAndClone':
      return {
        type: 'preset_and_clone',
        count: v.preset.count,
        per_language: v.preset.perLanguage,
        requires_text: v.clone.requiresText
      }
    default:
      return { type: 'fixed' }
  }
}

/** 描述符声明"必需"的**模型目录内**文件里当前缺失的（只有 SherpaTts 后端声明了该清单）。 */
function missingRequiredFiles(spec: ModelSpec, dir: string): string[] {
  if (spec.backend.type !== 'sherpaTts') return []
  return spec.backend.requiredFiles.filter((f) => !existsSync(join(dir, f)))
}

/**
 * 描述符声明的**附加文件**（落模型根；如 Matcha 的 vocos-22khz-univ.onnx、ZipVoice 的
 * vocos_24khz.onnx）里当前缺失的。它们与模型包分开下载，漏了就是"装不完整"。
 */
function missingExtraFiles(spec: ModelSpec, root: string): string[] {
  return spec.extraFiles.filter((e) => !existsSync(join(root, e.destRel))).map((e) => e.destRel)
}

/**
 * 模型是否**装全**：目录像样（`isComplete` 的通用启发式）+ 声明的必需文件与附加文件都在。
 *
 * 只靠 `isComplete` 会把"缺 vocoder 的 Matcha"也算成已下载（用户实际撞到的静默不完整）。
 * 能否跳过整包下载：主体目录已完整、且声明的必需文件都在 —— 只缺附加文件（vocoder）时为真。
 *
 * 与 `specInstalled` 的区别：这里**不要求**附加文件已存在（正因为缺它才要走"补下载"）。
 */
function canSkipArchive(spec: ModelSpec, dir: string): boolean {
  return isComplete(dir) && missingRequiredFiles(spec, dir).length === 0
}

/** 模型是否装全（目录像样 + 必需文件 + 附加文件都在） */
export function specInstalled(spec: ModelSpec, dir: string, root: string): boolean {
  return (
    isComplete(dir) &&
    missingRequiredFiles(spec, dir).length === 0 &&
    missingExtraFiles(spec, root).length === 0
  )
}

/**
 * 该模型所有条目的文件并集（按声明顺序去重）。
 *
 * 下载即"下全"：切换条目只改 manifest 的 active 指针，**不再需要重新下载**。
 */
export function entryUnion(spec: ModelSpec): EntryFileSpec[] {
  const out: EntryFileSpec[] = []
  for (const entry of spec.entries) {
    for (const f of entry.files) {
      if (!out.some((u) => u.name === f.name)) out.push(f)
    }
  }
  return out
}

/**
 * 运行时包清单（`engine` / `framework` 对）—— 对齐 Rust `inference::runtime_download::RUNTIME_PACKAGES`。
 *
 * 只取清单 payload 需要的两个字段：模型的 `runtime_keys` = 同引擎的所有可用包 key。
 * （完整运行时包表随 `runtime_download` 一起移植；此处只固化这份映射关系。）
 */
const RUNTIME_PACKAGE_KEYS: ReadonlyArray<{ engine: string; framework: string }> = [
  { engine: 'gguf', framework: 'gguf' },
  { engine: 'onnx', framework: 'onnx' },
  { engine: 'pytorch', framework: 'pytorch-cpu' },
  { engine: 'pytorch', framework: 'pytorch-cuda130' }
]

/** 精选条目（payload 形状） */
export type ModelEntryPayload = {
  id: string
  label_zh: string
  label_en: string
  size_gb: number
  /** 预计显存（MiB）：下载体积之外的真实占用量级；只有文件齐了才算（否则 null） */
  vram_estimate_mb: number | null
  default: boolean
  state: 'downloaded' | 'not_downloaded' | 'downloading'
}

/** 模型条目（payload 形状；键名 = 前后端协议，snake_case） */
export type ModelItemPayload = {
  name: string
  kind: 'asr' | 'tts'
  format: string
  /** 新增（只增不改）：前端据此分组/门禁，不再自行做 format→framework 推导 */
  engine: string
  runtime_key: string
  source: string
  entries: ModelEntryPayload[]
  active_entry: string | null
  size_gb: number
  vram_estimate_mb: number | null
  description_zh: string
  description_en: string
  available: boolean
  cpu: string
  quant: string | null
  path: string
  state: 'downloaded' | 'not_downloaded' | 'downloading'
  dir_exists: boolean
  size_on_disk_gb?: number
  model_path?: string
  mmproj_path?: string
  languages: string[]
  runtime_keys: string[]
  language_mode: string
  voice_mode: Record<string, unknown>
  supports_clone: boolean
}

/** 模型清单 payload（`models_state` 事件；键名 = 前后端协议，snake_case） */
export type ModelsStatePayload = {
  status: 'models_state'
  model_root: string
  proxy: string
  disk_free_gb: number | null
  models: ModelItemPayload[]
}

/** 条目体积（GB）——由声明文件体积求和（单一真源，不再单独维护） */
function entrySizeGb(entry: DownloadEntrySpec): number {
  return entry.files.reduce((sum, f) => sum + f.sizeMb, 0) / 1024
}

/**
 * 模型清单 payload（`models_state` 事件）。
 *
 * 字段名是前后端协议：Rust 用 snake_case 下发，前端按同样字段名读取
 * （见 renderer `modelsSlice.applyModelsState`）。
 */
export function listModelsPayload(kind?: string): ModelsStatePayload {
  const root = getModelRoot()
  const proxy = getProxy()
  const hub = join(root, 'hub')
  try {
    mkdirSync(hub, { recursive: true })
  } catch {
    // 建不出来也不影响清单本身
  }
  const items: ModelItemPayload[] = []
  for (const spec of SPECS) {
    if (kind !== undefined && spec.kind !== kind) continue
    // sherpa-onnx E2E 模型的目录名与展示名不同（如 Kokoro-v1_0 → kokoro-multi-lang-v1_0）
    // 统一用引擎目录名判定（与下载/删除/TTS 引擎一致）
    const dir = resolveDownloadDir(root, spec.name)
    const state: ModelItemPayload['state'] = isDownloading(spec.name)
      ? 'downloading'
      : specInstalled(spec, dir, root)
        ? 'downloaded'
        : 'not_downloaded'
    // 精选条目：每条的安装状态（manifest 核大小）+ 当前安装条目标记
    const downloadingEntry = ACTIVE.get(spec.name)?.entryId
    const entries: ModelEntryPayload[] = spec.entries.map((e) => ({
      id: e.id,
      label_zh: e.labelZh,
      label_en: e.labelEn,
      size_gb: entrySizeGb(e),
      // 预计显存（MiB）：下载体积之外的真实占用量级；只有文件齐了才算（否则 null）
      vram_estimate_mb: entryVramEstimateMb(dir, e),
      default: e.default,
      state:
        downloadingEntry === e.id
          ? 'downloading'
          : entryInstalled(dir, spec, e.id)
            ? 'downloaded'
            : 'not_downloaded'
    }))
    const activeEntry = activeEntryOf(spec)?.id ?? null
    // 兼容旧布局残留：引擎目录不存在但展示名目录存在（如下载失败留了 Kokoro-v1_1）
    const legacyDir = join(root, spec.name)
    const dirExists = isDir(dir) || (legacyDir !== dir && isDir(legacyDir))
    const fmt = runtimeKey(spec.framework) ?? spec.framework
    const obj: ModelItemPayload = {
      name: spec.name,
      kind: spec.kind,
      format: fmt,
      engine: frameworkSpec(spec.framework)?.engine ?? '',
      runtime_key: fmt,
      source: sourceLabel(spec.source),
      entries,
      active_entry: activeEntry,
      size_gb: spec.sizeGb,
      // 预计显存：优先当前激活条目，否则默认条目（均只在文件齐时给出）
      vram_estimate_mb: pickVramEstimateMb(spec, dir, activeEntry),
      description_zh: spec.descriptionZh,
      description_en: spec.descriptionEn,
      available: spec.available,
      cpu: spec.cpu,
      quant: spec.quant,
      path: dir,
      state,
      dir_exists: dirExists,
      languages: spec.languages,
      runtime_keys: RUNTIME_PACKAGE_KEYS.filter((p) => p.engine === spec.framework).map((p) => p.framework),
      language_mode: languageModeStr(spec.languageMode),
      voice_mode: voiceModeJson(spec.voiceMode),
      supports_clone: spec.voiceMode.type === 'clone' || spec.voiceMode.type === 'presetAndClone'
    }
    if (state === 'downloaded') {
      // 有清单就走清单 / 无清单走缓存版遍历（不每轮递归）
      const bytes = onDiskBytesCached(dir)
      obj.size_on_disk_gb = Math.round((bytes / 1024 ** 3) * 100) / 100
      // 附带主模型文件路径，方便前端直接加载（发现结果带缓存，不每轮扫目录）
      const found = discoveredMainFiles(spec, dir)
      if (found.main) {
        obj.model_path = found.main
        if (found.mmproj) obj.mmproj_path = found.mmproj
      }
    }
    items.push(obj)
  }
  // 磁盘可用空间：同步快路径（statfs，毫秒级）；未命中时用兜底缓存值，
  // 兜底值由后台异步刷新（PowerShell 已改异步，这里不能 await）
  const diskFree = freeBytesForRootSync()
  const diskFreeGb = diskFree === null ? null : Math.round((diskFree / 1024 ** 3) * 10) / 10
  lastDiskFreeGb = diskFreeGb
  void refreshDiskFreeInBackground()
  return {
    status: 'models_state',
    model_root: root,
    proxy,
    disk_free_gb: diskFreeGb,
    models: items
  }
}

/**
 * 模型级「预计显存」：优先当前激活条目，否则默认条目，再退回任意能估出来的条目。
 * （Rust：`.find(active).or_else(default).into_iter().chain(entries).find_map(...)`）
 */
function pickVramEstimateMb(
  spec: ModelSpec,
  dir: string,
  activeEntry: string | null
): number | null {
  const active = activeEntry !== null ? spec.entries.find((e) => e.id === activeEntry) : undefined
  const first = active ?? defaultEntry(spec)
  const candidates: DownloadEntrySpec[] = []
  if (first) candidates.push(first)
  candidates.push(...spec.entries)
  for (const e of candidates) {
    const v = entryVramEstimateMb(dir, e)
    if (v !== null) return v
  }
  return null
}

/** 广播模型清单状态 */
export function emitModelsState(): void {
  emitSidecar(listModelsPayload())
}

// ── HTTP 下载（对齐 Rust `crate::net`）──

/** 取消哨兵：与既有调用方约定一致（`runDownload` 识别该串判定为用户取消） */
const CANCELLED = '__CANCELLED__'

const THROTTLE_MS = 500
const MAX_ATTEMPTS = 3
const MAX_REDIRECTS = 10
const DOWNLOAD_TIMEOUT_MS = 3600 * 1000

/** 取消标志（Rust 的 `Arc<AtomicBool>` → 普通对象） */
export interface CancelFlag {
  cancelled: boolean
}

/** 网络错误（retryable 决定是否重试） */
class NetError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'NetError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

/**
 * 解析代理配置：空 → 不走代理；非法 → 抛错（与 Rust 的 `Proxy::all` 失败口径一致）。
 */
export function parseProxy(proxy: string): URL | null {
  const p = proxy.trim()
  if (!p) return null
  try {
    const u = new URL(p)
    if (u.protocol !== 'http:' && u.protocol !== 'socks5:' && u.protocol !== 'socks5h:') {
      throw new Error('bad protocol')
    }
    return u
  } catch {
    throw new Error(`代理格式无效（支持 http:// 或 socks5://）: ${p}`)
  }
}

/** 原始 HTTP 响应 */
interface RawResponse {
  status: number
  headers: IncomingHttpHeaders
  stream: Readable
}

/** 读字节缓冲器（握手阶段用；读完即从流上摘掉，避免吞掉后续数据） */
class SocketReader {
  private buf: Buffer = Buffer.alloc(0)
  private waiters: Array<() => void> = []
  private error: Error | null = null

  private onData = (d: Buffer): void => {
    this.buf = Buffer.concat([this.buf, d])
    this.wake()
  }

  private onError = (e: Error): void => {
    this.error = e
    this.wake()
  }

  private onClose = (): void => {
    if (!this.error) this.error = new Error('连接提前关闭')
    this.wake()
  }

  constructor(private readonly sock: Socket) {
    sock.on('data', this.onData)
    sock.on('error', this.onError)
    sock.on('close', this.onClose)
  }

  private wake(): void {
    const w = this.waiters
    this.waiters = []
    for (const fn of w) fn()
  }

  /** 读满 n 字节 */
  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (this.error) throw this.error
      await new Promise<void>((res) => this.waiters.push(res))
    }
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }

  /** 读到分隔符为止（含分隔符） */
  async readUntil(marker: string): Promise<string> {
    const m = Buffer.from(marker)
    for (;;) {
      const idx = this.buf.indexOf(m)
      if (idx >= 0) {
        const head = this.buf.subarray(0, idx + m.length)
        this.buf = this.buf.subarray(idx + m.length)
        return head.toString('latin1')
      }
      if (this.error) throw this.error
      await new Promise<void>((res) => this.waiters.push(res))
    }
  }

  /** 交出 socket（停止读数据） */
  detach(): void {
    this.sock.removeListener('data', this.onData)
    this.sock.removeListener('close', this.onClose)
    this.sock.removeListener('error', this.onError)
    // 保留一个空监听，避免交出后 socket 报错变成未捕获异常
    this.sock.on('error', () => {})
    this.sock.pause()
  }
}

function waitForConnect(sock: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error): void => {
      cleanup()
      reject(e)
    }
    const onConnect = (): void => {
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      sock.removeListener('error', onError)
      sock.removeListener('connect', onConnect)
    }
    sock.once('error', onError)
    sock.once('connect', onConnect)
  })
}

/** HTTP 代理：CONNECT 隧道 */
async function connectViaHttpProxy(proxy: URL, host: string, port: number): Promise<Socket> {
  const sock = netConnect({ host: proxy.hostname, port: Number(proxy.port || 80) })
  await waitForConnect(sock)
  const reader = new SocketReader(sock)
  sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
  const head = await reader.readUntil('\r\n\r\n')
  const statusLine = head.split('\r\n')[0] ?? ''
  const m = /HTTP\/1\.[01]\s+(\d+)/.exec(statusLine)
  const code = m ? Number(m[1]) : 0
  if (code !== 200) {
    sock.destroy()
    throw new Error(`代理 CONNECT 失败: HTTP ${code}`)
  }
  reader.detach()
  return sock
}

/** SOCKS5 代理：握手 + CONNECT */
async function connectViaSocks5(proxy: URL, host: string, port: number): Promise<Socket> {
  const sock = netConnect({ host: proxy.hostname, port: Number(proxy.port || 1080) })
  await waitForConnect(sock)
  const reader = new SocketReader(sock)
  // 1. 认证方法协商（只支持"无认证"）
  sock.write(Buffer.from([0x05, 0x01, 0x00]))
  const greet = await reader.read(2)
  if (greet[0] !== 0x05 || greet[1] !== 0x00) {
    sock.destroy()
    throw new Error('SOCKS5 代理不支持无认证连接')
  }
  // 2. CONNECT 请求（域名寻址）
  const hostBuf = Buffer.from(host, 'utf-8')
  const req = Buffer.alloc(5 + hostBuf.length + 2)
  req[0] = 0x05
  req[1] = 0x01
  req[2] = 0x00
  req[3] = 0x03
  req[4] = hostBuf.length
  hostBuf.copy(req, 5)
  req.writeUInt16BE(port, 5 + hostBuf.length)
  sock.write(req)
  // 3. 读应答
  const head = await reader.read(4)
  if (head[0] !== 0x05 || head[1] !== 0x00) {
    sock.destroy()
    throw new Error(`SOCKS5 连接失败: 错误码 ${head[1]}`)
  }
  const atyp = head[3]
  if (atyp === 0x01) await reader.read(4)
  else if (atyp === 0x04) await reader.read(16)
  else if (atyp === 0x03) {
    const len = await reader.read(1)
    await reader.read(len[0])
  }
  await reader.read(2) // 端口
  reader.detach()
  return sock
}

/** TLS 包裹（代理隧道用） */
function wrapTls(raw: Socket, host: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const tlsSock = tlsConnect({ socket: raw, servername: host })
    const onError = (e: Error): void => {
      tlsSock.removeListener('secureConnect', onSecure)
      reject(e)
    }
    const onSecure = (): void => {
      tlsSock.removeListener('error', onError)
      resolve(tlsSock)
    }
    tlsSock.once('error', onError)
    tlsSock.once('secureConnect', onSecure)
  })
}

/** 通过代理建立到目标的连接 */
async function openProxiedSocket(
  proxy: URL,
  host: string,
  port: number,
  isHttps: boolean
): Promise<Socket> {
  let raw: Socket
  if (proxy.protocol === 'http:') raw = await connectViaHttpProxy(proxy, host, port)
  else raw = await connectViaSocks5(proxy, host, port)
  raw.setNoDelay(true)
  if (!isHttps) return raw
  return wrapTls(raw, host)
}

/** 发一次 HTTP 请求（不跟随重定向） */
async function requestRaw(
  url: string,
  method: string,
  headers: Record<string, string>,
  proxy: URL | null
): Promise<RawResponse> {
  const u = new URL(url)
  const isHttps = u.protocol === 'https:'
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const port = u.port ? Number(u.port) : isHttps ? 443 : 80

  const options: RequestOptions = {
    method,
    headers: { ...headers, host: u.host },
    agent: false
  }

  if (proxy) {
    const sock = await openProxiedSocket(proxy, host, port, isHttps)
    // 必须用**自定义 Agent** 把已隧道化的 socket 交给请求：
    // `options.createConnection` 在 Node 的 ClientRequest 里不会被采用
    // （Agent 自己走 net.createConnection），结果是绕开代理直连 → ECONNREFUSED。
    const agent = (isHttps ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false })) as unknown as {
      createConnection: (
        opts: unknown,
        cb: (err: Error | null, socket?: Duplex | null) => void
      ) => void
    }
    agent.createConnection = (_opts, cb) => {
      cb(null, sock)
    }
    options.agent = agent as unknown as RequestOptions['agent']
  }

  return new Promise<RawResponse>((resolve, reject) => {
    const req = (isHttps ? httpsRequest : httpRequest)(u, options)
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error('请求超时'))
    })
    req.on('response', (res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res })
    })
    req.on('error', (e) => reject(e))
    req.end()
  })
}

/** 发 HTTP 请求并跟随重定向（最多 10 跳，对齐 reqwest 默认） */
async function httpFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  proxy: URL | null
): Promise<RawResponse> {
  let current = url
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await requestRaw(current, method, headers, proxy)
    if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) {
      const loc = res.headers['location']
      res.stream.resume()
      if (typeof loc === 'string' && loc) {
        current = new URL(loc, current).toString()
        continue
      }
    }
    return res
  }
  throw new NetError(`重定向过多: ${url}`, true)
}

/** HEAD 取文件大小（失败 → null；仅用于进度权重，不阻断下载）。走显式代理。 */
export async function headSize(url: string, proxy: URL | null): Promise<number | null> {
  try {
    const res = await httpFetch(url, 'HEAD', {}, proxy)
    res.stream.resume()
    if (res.status < 200 || res.status >= 300) return null
    const len = Number(res.headers['content-length'] ?? 0)
    return Number.isFinite(len) && len > 0 ? len : null
  } catch {
    return null
  }
}

/** URL 末段的归档扩展名（`"tar.bz2"` / `"zip"` / `"bin"`） */
export function urlSuffix(url: string): string {
  const parts = url.split('/')
  const file = (parts[parts.length - 1] ?? url).toLowerCase()
  const table: Array<[string, string]> = [
    ['.tar.bz2', 'tar.bz2'],
    ['.tar.gz', 'tar.gz'],
    ['.tgz', 'tgz'],
    ['.zip', 'zip'],
    ['.tar', 'tar']
  ]
  for (const [ext, name] of table) {
    if (file.endsWith(ext)) return name
  }
  return 'bin'
}

/** 一次下载的参数 */
export interface DownloadOptions {
  url: string
  /** 最终落盘路径（实际写 `<dest>.part`，完成后 rename） */
  dest: string
  /** 进度回调（已节流；total = null 表示服务器未给 Content-Length） */
  onProgress?: (downloaded: number, total: number | null) => void
  cancel?: CancelFlag
  /** 附加请求头（如 HF token；调用方负责只在需要的 host 上带） */
  headers?: Record<string, string>
  /** 代理（显式；null = 直连） */
  proxy?: URL | null
}

/**
 * 下载到 `dest`；返回最终字节数。失败抛错（取消为 `__CANCELLED__`）。
 *
 * 行为契约（对齐 Rust `crate::net::download`）：
 * - **流式落盘**：64KB 块边读边写，不整包进内存
 * - **断点续传**：写 `<dest>.part`；已存在则带 `Range` 续；服务器不支持（返 200）→ 截断重下；
 *   服务器返 416（`.part` 已超出目标长度）→ 删 `.part` 重下
 * - **原子完成**：读完后 `rename(.part → dest)`，`dest` 已存在且非空则直接跳过
 * - **重试**：连接 / 超时 / 读错 / 408 / 429 / 5xx 视为瞬时错误，最多 3 次（0.5s、1s 退避）
 * - **取消**：每块检查取消标志；取消抛 `__CANCELLED__`，**保留 `.part`**（下次可续）
 * - **进度**：500ms 节流回调 `(已下载, 总大小)`
 */
export async function netDownload(opts: DownloadOptions): Promise<number> {
  // 已完整落盘（调用方负责用完后删除）：直接复用，天然支持"解压失败后重跑不重下"
  try {
    const st = statSync(opts.dest)
    if (st.isFile() && st.size > 0) return st.size
  } catch {
    // 不存在 → 正常下载
  }
  try {
    mkdirSync(dirname(opts.dest), { recursive: true })
  } catch (e) {
    throw new Error(`create dir ${dirname(opts.dest)}: ${(e as Error).message}`)
  }
  const part = `${opts.dest}.part`
  let attempt = 0
  for (;;) {
    attempt += 1
    try {
      const n = await fetchOnce(opts, part)
      try {
        renameSync(part, opts.dest)
      } catch (e) {
        throw new NetError(`rename ${part} -> ${opts.dest}: ${(e as Error).message}`, false)
      }
      opts.onProgress?.(n, n)
      return n
    } catch (e) {
      const err = e instanceof NetError ? e : new NetError((e as Error).message, true)
      if (err.message === CANCELLED) throw err
      if (!err.retryable) throw err
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`${err.message}（已重试 ${attempt} 次）`)
      }
      log.warn(`[net] 下载中断（第 ${attempt}/${MAX_ATTEMPTS} 次），从断点重试: ${err.message}`)
      await sleep(500 << (attempt - 1))
    }
  }
}

/** 单次 HTTP 请求：支持从 `.part` 续传；成功返回累计字节数（含续传部分） */
async function fetchOnce(opts: DownloadOptions, part: string): Promise<number> {
  let existing = 0
  try {
    existing = statSync(part).size
  } catch {
    existing = 0
  }
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (existing > 0) headers['Range'] = `bytes=${existing}-`

  const res = await httpFetch(opts.url, 'GET', headers, opts.proxy ?? null)

  if (res.status === 416 && existing > 0) {
    // `.part` 比目标还长（版本变更/上次中断留下的脏数据）→ 丢弃后重试
    try {
      unlinkSync(part)
    } catch {
      // 删不掉就当没删（下次会再撞 416）
    }
    throw new NetError(`HTTP 416，已丢弃残留分片重下: ${opts.url}`, true)
  }
  if (res.status < 200 || res.status >= 300) {
    const transient = res.status === 408 || res.status === 429 || res.status >= 500
    throw new NetError(`HTTP ${res.status} from ${opts.url}`, transient)
  }

  const resuming = existing > 0 && res.status === 206
  const start = resuming ? existing : 0
  const bodyLen = Number(res.headers['content-length'] ?? 0)
  const total = bodyLen > 0 ? start + bodyLen : null
  // 日志：与旧实现一致地暴露"本次是从头还是续传"
  const tail = opts.url.split('/').pop() ?? opts.url
  log.info(
    `[net] ${resuming ? '续传' : '下载'} ${tail}（${(bodyLen / 1024 / 1024).toFixed(1)} MB）`
  )

  const fd = openSync(part, resuming ? 'a+' : 'w')
  let done = start
  try {
    let last = Date.now()
    opts.onProgress?.(done, total)
    for await (const chunk of res.stream) {
      if (opts.cancel?.cancelled) throw new NetError(CANCELLED, false)
      const buf = chunk as Buffer
      let off = 0
      while (off < buf.length) {
        off += writeSync(fd, buf, off, buf.length - off)
      }
      done += buf.length
      if (Date.now() - last >= THROTTLE_MS) {
        opts.onProgress?.(done, total)
        last = Date.now()
      }
    }
  } finally {
    closeSync(fd)
  }
  return done
}

// ── 下载管理 ──

/** 进行中的下载：模型名 → (取消标志, 目标条目 id) */
interface ActiveDownload {
  cancel: CancelFlag
  entryId: string
}

const ACTIVE = new Map<string, ActiveDownload>()

/**
 * 模型下载进度事件的**唯一构造点**——字段名即前端协议（`percent` / `downloaded_bytes` / `total_bytes`）。
 *
 * 曾经 Rust 发 `progress`/`downloaded`/`total`，前端读 `percent`/`downloaded_bytes`/`total_bytes`
 * ⇒ 百分比永远是 null：界面显示不确定态转圈 + 字面 `{percent}`，字节数也不显示（本机实测踩到）。
 * 集中构造 + 单测锁字段，避免再次漂移。
 */
export function downloadProgressEvent(
  model: string,
  percent: number,
  downloadedBytes: number | null,
  totalBytes: number | null
): Record<string, unknown> {
  return {
    status: 'model_download_progress',
    model,
    percent,
    downloaded_bytes: downloadedBytes ?? 0,
    total_bytes: totalBytes ?? 0
  }
}

export function isDownloading(name: string): boolean {
  return ACTIVE.has(name)
}

/** llama.cpp 推理的默认 ctx（与历史 llama-server 路线保持一致） */
const DEFAULT_CTX_SIZE = 2048

/**
 * 开始下载；`entryId` 为空 = 默认条目（无条目的模型忽略该参数）。
 *
 * 迁移旧布局：E2E 模型曾下载到展示名目录（如 models/Matcha-zh-baker），
 * 现在引擎找引擎目录名（matcha-icefall-zh-baker）。若旧目录已存在且完整，
 * 直接迁移到新目录名并返回"已就绪"，避免用户重新下载。
 */
export async function startDownload(name: string, entryId: string): Promise<void> {
  const spec = findSpec(name)
  if (!spec) throw new Error(`unknown model: ${name}`)
  if (!spec.available) {
    throw new Error(`engine not available yet: ${spec.name}`)
  }
  // 校验目标条目存在（空 = 默认条目）；下载按"并集"进行，故此处只需校验
  if (spec.entries.length > 0) {
    const entry = entryId ? specEntry(spec, entryId) : defaultEntry(spec)
    if (!entry) throw new Error(`unknown entry: ${entryId}`)
  }

  // 迁移旧布局：E2E 模型曾下载到展示名目录（如 models/Matcha-zh-baker），
  // 现在引擎找引擎目录名（matcha-icefall-zh-baker）。若旧目录已存在且完整，
  // 直接迁移到新目录名并返回"已就绪"，避免用户重新下载。
  const root = getModelRoot()
  const newDir = resolveDownloadDir(root, spec.name)
  const oldDir = join(root, spec.name)
  if (oldDir !== newDir && isDir(oldDir) && !existsSync(newDir)) {
    if (isComplete(oldDir)) {
      try {
        renameSync(oldDir, newDir)
        console.error(`[model] migrated ${oldDir} -> ${newDir}`)
        emitSidecar({
          status: 'model_downloaded',
          model: spec.name,
          path: newDir
        })
        emitModelsState()
        return
      } catch {
        // 迁移失败 → 走正常下载
      }
    }
  }
  // 占位要早于磁盘预检（下面有 await 点），否则并发点击会重复下载
  const cancel: CancelFlag = { cancelled: false }
  if (ACTIVE.has(spec.name)) {
    return // 同模型已在下载（含切条目），忽略重复点击
  }
  ACTIVE.set(spec.name, { cancel, entryId })
  // 磁盘预检（异步：PowerShell 兜底不能占 Electron 主线程）
  const free = await freeBytesForRoot()
  if (free !== null) {
    // 峰值 = 下载归档 + 解压产物（解压期间两者并存）≈ 2× 体积；
    // 有条目时按**并集**体积（一次下全，切换不再下）
    const needGb =
      (spec.entries.length === 0
        ? spec.sizeGb
        : entryUnion(spec).reduce((sum, f) => sum + f.sizeMb, 0) / 1024) * 2
    const need = Math.floor(needGb * 1024 ** 3)
    if (free < need) {
      // 预检没过：撤销占位，别把模型卡在「下载中」
      ACTIVE.delete(spec.name)
      throw new Error(
        `disk full: need ~${needGb.toFixed(1)}GB, free ${(free / 1024 ** 3).toFixed(1)}GB`
      )
    }
  }
  // 后台执行（Rust 是 spawn 一个线程）
  void runDownload(spec, entryId, cancel)
}

/** 请求取消下载（返回是否命中进行中的下载） */
export function requestCancel(name: string): boolean {
  const active = ACTIVE.get(name)
  if (!active) return false
  active.cancel.cancelled = true
  return true
}

/** 删除模型（返回释放的字节数） */
export function deleteModel(name: string): number {
  if (!findSpec(name)) throw new Error(`unknown model: ${name}`)
  if (isDownloading(name)) {
    throw new Error(`downloading: ${name}`)
  }
  const root = getModelRoot()
  // 顺带清理该模型的下载临时物（`.tmp/<name>.*`：中断留下的 .part / 解压失败的归档）
  const tmpDir = join(root, '.tmp')
  try {
    for (const f of readdirSync(tmpDir)) {
      if (f.startsWith(`${name}.`)) {
        try {
          unlinkSync(join(tmpDir, f))
        } catch {
          // 删不掉就跳过
        }
      }
    }
  } catch {
    // 没有 .tmp 目录
  }
  // 删除目标目录：优先引擎目录名，同时兼容旧布局展示名残留（如 Kokoro-v1_1）
  const dir = resolveDownloadDir(root, name)
  const legacyDir = join(root, name)
  if (!existsSync(dir) && legacyDir !== dir && existsSync(legacyDir)) {
    // 旧布局残留：删展示名目录
    const freed = dirSizeBytes(legacyDir)
    rmSync(legacyDir, { recursive: true, force: true })
    return freed
  }
  if (!existsSync(dir)) {
    throw new Error(`not found: ${name}`)
  }
  const freed = dirSizeBytes(dir)
  rmSync(dir, { recursive: true, force: true })
  return freed
}

/** 下载主流程（Rust `run_download`） */
async function runDownload(spec: ModelSpec, entryId: string, cancel: CancelFlag): Promise<void> {
  const name = spec.name
  // 下载目标目录：E2E 模型用引擎目录名（与 TTS 引擎查找一致）
  const dest = resolveDownloadDir(getModelRoot(), name)
  emitSidecar({ status: 'model_download_started', model: name })
  emitModelsState()

  let result: { ok: true } | { ok: false; error: Error }
  try {
    // 有条目的模型（HF 源）：按条目精确文件逐个下载 + 落账 manifest
    if (spec.entries.length > 0) {
      const entry = entryId ? specEntry(spec, entryId) : defaultEntry(spec)
      if (!entry) throw new Error(`unknown entry: ${entryId}`)
      await downloadModelFiles(spec, entry, cancel)
      result = { ok: true }
    } else {
      // 无条目的模型：整包下载（GitHub release 资产）后解压。
      // 但"主体已完整、只缺附加文件"时不重拖整包 —— 典型场景：描述符修好之前下载的 Matcha
      // 缺 vocoder，重下整包要几百 MB，而这里只需补那 54MB。
      if (canSkipArchive(spec, dest)) {
        log.info(`[download] ${spec.name}：主体已完整，仅补附加文件`)
        result = { ok: true }
      } else {
        mkdirSync(dest, { recursive: true })
        const source = spec.source
        if (source.type === 'github') {
          await downloadGithubRelease(source.url ?? '', dest, name, cancel)
        } else {
          throw new Error(
            `${spec.name}：HF 源必须声明精选条目（entries），当前为 ${source.repo ?? ''}`
          )
        }
        result = { ok: true }
      }
    }
  } catch (e) {
    result = { ok: false, error: e as Error }
  }

  ACTIVE.delete(name)

  if (result.ok) {
    // 附加文件（描述符声明，如 ZipVoice 的 vocoder）：落模型根，已存在则跳过
    for (const extra of spec.extraFiles) {
      const extraDest = join(getModelRoot(), extra.destRel)
      if (existsSync(extraDest)) continue
      let url: string
      if (extra.source.type === 'github') {
        url = extra.source.url ?? ''
      } else {
        console.error(`[download] 附加文件暂不支持 HF 源: ${extra.source.repo ?? ''}`)
        continue
      }
      emitSidecar(downloadProgressEvent(name, 0, null, null))
      try {
        await downloadSingleFile(url, extraDest, name, cancel)
        console.error(`[download] extra file downloaded: ${extraDest}`)
      } catch (e) {
        console.error(`[download] extra file download failed: ${(e as Error).message}`)
      }
    }
    const sizeBytes = dirSizeBytes(dest)
    emitSidecar({
      status: 'model_downloaded',
      model: name,
      path: dest,
      size_bytes: sizeBytes
    })
  } else if (result.error.message === CANCELLED) {
    emitSidecar({ status: 'model_download_cancelled', model: name })
  } else if (cancel.cancelled) {
    emitSidecar({ status: 'model_download_cancelled', model: name })
  } else {
    emitSidecar({ status: 'model_download_error', model: name, msg: result.error.message })
  }
  emitModelsState()
}

/**
 * 按"并集"下载该模型需要的全部文件并落账 manifest（active = 目标条目）。HF 源
 */
async function downloadModelFiles(
  spec: ModelSpec,
  target: DownloadEntrySpec,
  cancel: CancelFlag
): Promise<void> {
  const source = spec.source
  if (source.type !== 'huggingface' || !source.repo || !source.revision) {
    throw new Error(`${spec.name}：条目下载要求 HuggingFace 源`)
  }
  const repo = source.repo
  const revision = source.revision
  const dir = resolveDownloadDir(getModelRoot(), spec.name)
  mkdirSync(dir, { recursive: true })
  const proxy = parseProxy(getProxy())
  const previous = readManifest(dir)
  const files = entryUnion(spec)
  const urls = files.map((f) => hfFileUrl(repo, revision, f.name))
  // 体积权重：HEAD 优先（失败不阻断），退回声明体积
  const weights: number[] = []
  for (const [i, u] of urls.entries()) {
    const f = files[i]
    const head = await headSize(u, proxy)
    weights.push(head !== null && head > 0 ? head : (f?.sizeMb ?? 0) * 1024 * 1024)
  }
  const total = weights.reduce((a, b) => a + b, 0)
  const spans: Array<[number, number]> = []
  let cursor = 0
  for (const size of weights) {
    const w = total > 0 ? Math.round((size / total) * 100) : 0
    const end = Math.min(cursor + w, 100)
    spans.push([cursor, end])
    cursor = end
  }
  if (spans.length > 0) {
    spans[spans.length - 1][1] = 100
  }

  const token = configToken()
  const manifestFiles: Array<[string, number]> = []
  for (const [i, file] of files.entries()) {
    const url = urls[i]
    const span = spans[i] ?? [0, 100]
    const dest = join(dir, file.name)
    const [s, e] = span
    // 已在本地：无 size 记录 → 直接复用；有记录 → 一致才复用，不一致先删再下
    let reused = false
    try {
      const md = statSync(dest)
      if (md.isFile() && md.size > 0) {
        const recorded = previous?.files.find(([n]) => n === file.name)?.[1]
        if (recorded !== undefined && recorded > 0 && recorded !== md.size) {
          try {
            unlinkSync(dest)
          } catch {
            // 删不掉就让下载覆盖
          }
        } else {
          manifestFiles.push([file.name, md.size])
          emitSidecar(downloadProgressEvent(spec.name, e, md.size, md.size))
          reused = true
        }
      }
    } catch {
      // 本地没有 → 正常下载
    }
    if (reused) continue
    const onProgress = (downloaded: number, got: number | null): void => {
      const pct = got !== null && got > 0 ? s + Math.floor((e - s) * (downloaded / got)) : s
      emitSidecar(downloadProgressEvent(spec.name, pct, downloaded, got))
    }
    const headers: Record<string, string> = {}
    const auth = hfAuthHeader(url, token)
    if (auth) headers[auth[0]] = auth[1]
    const written = await netDownload({
      url,
      dest,
      onProgress,
      cancel,
      headers,
      proxy
    })
    manifestFiles.push([file.name, written])
  }
  // 落账：active = 目标条目；files = **并集**（故切换条目无需重新下载）
  writeManifest(dir, {
    entry: target.id,
    repo,
    revision,
    files: manifestFiles
  })
  cleanupUndeclared(spec, previous, dir)
}

/**
 * 清理：只删"上一份 manifest 记录过、且当前没有任何条目再声明"的文件。
 *
 * 并集里的文件全部保留（切换条目不再重下）；未声明的第三方文件一律不碰。
 */
function cleanupUndeclared(spec: ModelSpec, previous: Manifest | null, dir: string): void {
  if (!previous) return
  const declared = entryUnion(spec).map((f) => f.name)
  for (const [name] of previous.files) {
    if (declared.includes(name)) continue
    const path = join(dir, name)
    if (isFile(path)) {
      try {
        unlinkSync(path)
        log.info(`[download] 清理已不再声明的旧文件: ${path}`)
      } catch {
        // 删不掉就留着
      }
    }
  }
}

/**
 * 从 GitHub releases 下载归档并解压到目标目录
 *
 * 归档落在 `<模型根>/.tmp/`（与模型目录分离）：解压成功后删除；解压失败保留，
 * 重跑时见归档已存在即跳过下载、只重试解压；中断则留 `<arch>.part` 供续传。
 */
async function downloadGithubRelease(
  url: string,
  dest: string,
  modelName: string,
  cancel: CancelFlag
): Promise<void> {
  const proxy = parseProxy(getProxy())
  const tmpDir = join(getModelRoot(), '.tmp')
  mkdirSync(tmpDir, { recursive: true })
  const arch = join(tmpDir, `${modelName}.${urlSuffix(url)}`)
  await netDownload({
    url,
    dest: arch,
    onProgress: downloadProgressEmitter(modelName),
    cancel,
    proxy
  })

  // 解压阶段：发"解压中"事件（进度无百分比，防 UI 停在 100% 像卡死）
  emitSidecar({ status: 'model_download_extracting', model: modelName })
  try {
    await extractArchiveAsync(arch, dest)
  } catch (e) {
    // 保留归档：重跑只重试解压，不重新下载
    throw e as Error
  }
  try {
    unlinkSync(arch)
  } catch {
    // 删不掉无所谓
  }
  flattenTarballSubdir(dest)
}

/** 下载单个文件（不解压，用于 vocoder 等附加文件）；带与其他模型下载一致的进度事件 */
async function downloadSingleFile(
  url: string,
  dest: string,
  modelName: string,
  cancel: CancelFlag
): Promise<void> {
  const proxy = parseProxy(getProxy())
  await netDownload({
    url,
    dest,
    onProgress: downloadProgressEmitter(modelName),
    cancel,
    proxy
  })
}

/** 模型下载进度事件发射器（`downloaded/total` 与 backend 现约定一致） */
function downloadProgressEmitter(modelName: string): (downloaded: number, total: number | null) => void {
  return (downloaded: number, total: number | null): void => {
    const pct = total !== null && total > 0 ? Math.floor((downloaded / total) * 100) : 0
    emitSidecar(downloadProgressEvent(modelName, pct, downloaded, total))
  }
}

/** GitHub tarball 解压后通常多一层目录（`sherpa-onnx-xxx/model.onnx`）→ 移到 `dest` 根 */
function flattenTarballSubdir(dest: string): void {
  let entries: string[]
  try {
    entries = readdirSync(dest)
  } catch (e) {
    throw new Error(`read_dir: ${(e as Error).message}`)
  }
  for (const name of entries) {
    const sub = join(dest, name)
    if (!isDir(sub)) continue
    let files: string[]
    try {
      files = readdirSync(sub)
    } catch {
      continue
    }
    const hasOnnx = files.some((f) => {
      const ext = f.slice(f.lastIndexOf('.') + 1)
      return ext === 'onnx' && f.includes('.')
    })
    if (!hasOnnx) continue
    for (const f of files) {
      const target = join(dest, f)
      try {
        renameSync(join(sub, f), target)
      } catch (e) {
        throw new Error(`move: ${(e as Error).message}`)
      }
    }
    try {
      rmSync(sub, { recursive: true, force: true })
    } catch {
      // 删不掉就留着空目录
    }
    break
  }
}

// ── 归档解压 ──────────────────────────────────────────────────────────────
//
// 解压统一走共享的异步实现（core/extract.ts）：Rust 版用同步 Command 解压，
// 移植到 Electron 后会占住主线程 ⇒ 渲染进程收不到 IPC ⇒ 窗口「未响应」被系统判 AppHang。
// 这里改成 spawn + Promise，解压期间主线程照常服务 IPC。

