/**
 * llama-server 子进程 + HTTP 桥接 —— 对齐 Rust 版 `src-tauri/src/inference/llama_server.rs`。
 *
 * 架构：Electron 主进程 → 启动 `llama-server.exe` 子进程 → HTTP/JSON 调用
 * - 崩溃隔离：子进程 crash 不会拉垮主进程
 * - 部署友好：只依赖一个 `llama-server.exe` + 模型文件，无 C++ 编译链
 * - 性能：已实测 ~92ms（2s 短句）/RTF 0.045，见 `benchmarks/BENCHMARK-RESULTS.md`
 *
 * 启动参数（已通过 benchmarks 验证，勿随意调整）：
 *   -m <model.gguf> --mmproj <mmproj.gguf> --port 8931
 *   -ngl 99 --ctx-size 2048 --parallel 1 --no-webui
 *
 * 重要：默认 ctx 大小会让 8GB 显存爆掉（→ 慢 500 倍），必须显式限制。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { SPECS, type ModelSpec } from '../models/spec-data'
import { activeEntryOf, mainModelFile, mmprojFile, modelDir } from '../models/model-manager'
import { log } from '../core/logger'
import type { AsrEngine, AsrStageCallback } from './engine'
import { findFreePort, killPortOwner, portServing, waitPortClosed } from './device'
import { llamaRuntimeDir } from './runtime-paths'

/** 默认 HTTP 端口（与启动参数一致） */
export const DEFAULT_PORT = 8931
/** 默认健康检查路径 */
export const HEALTH_PATH = '/health'
/** 默认转写 API 路径（OpenAI 兼容） */
export const TRANSCRIBE_PATH = '/v1/audio/transcriptions'
/** 多模态 chat 端点：带「上文」的转写走这里（可同时送 text + input_audio 两个 part） */
export const CHAT_PATH = '/v1/chat/completions'
/**
 * 默认上下文长度（KV cache 在加载时按此整块分配 → 直接决定显存占用；
 * 依据：分段上限 64s × 实测 13.2 token/s ≈ 850 token，2048 有近 2× 余量）
 */
export const DEFAULT_CTX_SIZE = 2048
/** 启动后等待就绪的最长时间 */
export const READY_TIMEOUT = 30_000

/** 子进程 stderr 保留行数（失败诊断用：显存/GPU 错误的特征行通常在最尾部） */
export const STDERR_TAIL_LINES = 40

/** "显存不足"特征（小写匹配）——命中即判定为 GPU 分配失败 */
export const OOM_STDERR_PATTERNS: readonly string[] = [
  'out of memory',
  'failed to allocate',
  'unable to allocate',
  'cudamalloc',
  'cuda_error_out_of_memory',
  'insufficient memory'
]

/** 其它 GPU 运行错误特征（驱动/显卡问题） */
export const GPU_STDERR_PATTERNS: readonly string[] = ['cuda error', 'cuda_error']

/** 健康检查轮询间隔 */
export const POLL_INTERVAL = 500

/** HTTP 超时（本地回环）：健康探测短、转写/对话长 */
const HEALTH_TIMEOUT = 1_500
const TRANSCRIBE_TIMEOUT = 120_000
const CHAT_TIMEOUT = 120_000

/**
 * 失败分类：`{ kind: 'oom' | 'gpu', line }`。
 *
 * 目的：显存不足时 llama.cpp 会在启动阶段直接失败，但旧实现只报「启动超时/立即退出」，
 * 用户干等 30s 也拿不到可操作信息。分类后直接给出「显存不足 + 需要/可用 + 建议」。
 */
export interface GpuFailure {
  kind: 'oom' | 'gpu'
  line: string
}

/** 从子进程 stderr 尾部判定失败性质（纯函数）：命中 OOM 特征优先，其次 GPU 特征。 */
export function classifyGpuFailure(lines: readonly string[]): GpuFailure | null {
  const hit = (patterns: readonly string[]): string | null => {
    for (const line of lines) {
      const low = line.toLowerCase()
      if (patterns.some((p) => low.includes(p))) return line.trim()
    }
    return null
  }
  const oom = hit(OOM_STDERR_PATTERNS)
  if (oom !== null) return { kind: 'oom', line: oom }
  const gpu = hit(GPU_STDERR_PATTERNS)
  if (gpu !== null) return { kind: 'gpu', line: gpu }
  return null
}

/** MiB → 展示串（null/undefined = 无法判定，不显示假数字） */
export function fmtMb(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未知'
  return `${value} MiB`
}

// ─── 配置 ────────────────────────────────────────────────────────────────

/** 启动参数配置（字段部分） */
export interface LlamaServerConfigFields {
  /** llama-server 可执行文件路径（绝对或相对于工作目录） */
  serverPath: string
  /** GGUF 主模型路径 */
  modelPath: string
  /** mmproj 视觉/音频投影模型路径（Qwen3-ASR 必须） */
  mmprojPath: string
  /** 监听端口 */
  port: number
  /** GPU 层卸载数量（99 = 全部卸载到 GPU） */
  nGpuLayers: number
  /** 上下文窗口大小（必须显式限制，否则小显存会爆） */
  ctxSize: number
  /** 并行槽数（输入法场景必须 = 1） */
  parallel: number
  /** 采样温度：ASR 用 greedy（0）最准，llama-server 默认 0.8 会引入随机噪声 */
  temperature: number
  /** 是否禁用 web UI */
  noWebui: boolean
  /** mmproj 投影塔是否卸载到 GPU（cuda 时 true，cpu 时 false） */
  mmprojOffload: boolean
}

/** 启动参数配置（含派生 URL） */
export interface LlamaServerConfig extends LlamaServerConfigFields {
  /** 健康检查 URL */
  healthUrl(): string
  /** 转写 API URL */
  transcribeUrl(): string
  /** 带上文转写的 chat API URL */
  chatUrl(): string
}

/** 构造配置对象（URL 方法实时读 port —— 换端口后无需重建） */
export function createLlamaServerConfig(fields: LlamaServerConfigFields): LlamaServerConfig {
  return {
    ...fields,
    healthUrl(): string {
      return `http://127.0.0.1:${this.port}${HEALTH_PATH}`
    },
    transcribeUrl(): string {
      return `http://127.0.0.1:${this.port}${TRANSCRIBE_PATH}`
    },
    chatUrl(): string {
      return `http://127.0.0.1:${this.port}${CHAT_PATH}`
    }
  }
}

/** 拷贝配置字段（不含派生方法） */
function configFields(cfg: LlamaServerConfig): LlamaServerConfigFields {
  return {
    serverPath: cfg.serverPath,
    modelPath: cfg.modelPath,
    mmprojPath: cfg.mmprojPath,
    port: cfg.port,
    nGpuLayers: cfg.nGpuLayers,
    ctxSize: cfg.ctxSize,
    parallel: cfg.parallel,
    temperature: cfg.temperature,
    noWebui: cfg.noWebui,
    mmprojOffload: cfg.mmprojOffload
  }
}

/** 两个模型路径是否指向同一文件（Windows 大小写不敏感 + 分隔符归一） */
export function pathsEqual(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
  return norm(a) === norm(b)
}

// ─── 本次启动记录（接管身份验证） ────────────────────────────────────────

/**
 * 本进程成功 spawn 的 server 配置记录。
 * 只有「本进程以相同配置启动过」的 server 才允许快速接管（runningMatches）；
 * 外部启动/上次崩溃残留的 server 无法验证其 -ngl 等加载参数 → 一律杀重启，
 * 保证「切模型/切设备」真实生效，杜绝假成功。
 */
export interface LaunchRec {
  modelPath: string
  mmprojPath: string
  nGpuLayers: number
}

/** 从配置生成启动记录 */
export function launchRecFromCfg(cfg: LlamaServerConfig): LaunchRec {
  return {
    modelPath: cfg.modelPath,
    mmprojPath: cfg.mmprojPath,
    nGpuLayers: cfg.nGpuLayers
  }
}

/** 启动记录是否与配置一致（模型 + mmproj + GPU 层数） */
export function launchRecMatches(rec: LaunchRec, cfg: LlamaServerConfig): boolean {
  return (
    pathsEqual(rec.modelPath, cfg.modelPath) &&
    pathsEqual(rec.mmprojPath, cfg.mmprojPath) &&
    rec.nGpuLayers === cfg.nGpuLayers
  )
}

// ─── HTTP 辅助 ───────────────────────────────────────────────────────────

/**
 * 回环 HTTP 请求：**禁用空闲连接复用**（每次新连接）+ **彻底禁用代理**。
 *
 * - llama-server 空闲后可能关闭 keep-alive 连接，池化复用 stale 连接会报
 *   "error sending request" / /health 探测失败 → is_loaded 假阴性。
 *   本地回环新连接开销毫秒级，可靠优先（对应 Rust 的 pool_idle_timeout=0）。
 * - Node 的 fetch **不读** HTTP_PROXY 等环境变量（默认 dispatcher 无代理），
 *   等价于 Rust 的 no_proxy()：环境里的代理绝不能让 127.0.0.1 绕一圈。
 */
async function fetchLoopback(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { connection: 'close', ...(init.headers ?? {}) }
    })
  } finally {
    clearTimeout(timer)
  }
}

/** 睡眠（毫秒） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── 显存账目（GGUF 几何 → KV cache → 预估） ─────────────────────────────

/** GGUF 的 KV 几何（只取算 KV cache 需要的三项） */
export interface GgufKvGeometry {
  /** 层数（`*.block_count`） */
  layers: number
  /** KV 头数（`*.attention.head_count_kv`） */
  kvHeads: number
  /** 每头维度（`*.attention.key_length`，缺失时用 value_length 或 embedding_length/head_count 推） */
  headDim: number
}

/** f16 KV cache 字节数 = ctx × 2(K+V) × layers × kv_heads × head_dim × 2B */
export function kvBytesF16(g: GgufKvGeometry, ctx: number): number {
  return ctx * 2 * g.layers * g.kvHeads * g.headDim * 2
}

/**
 * 进程级固定开销（CUDA 上下文 + cuBLAS 工作区 + 计算缓冲），MiB。
 *
 * 实测口径：驱动真值 −（权重 + mmproj + KV）≈ 620 MiB，且在 ctx 8192/4096/2048 三档一致
 * （0.6B Q8 + Q8 mmproj，RTX 4070 Laptop，`-ngl 99`）。模型越大计算缓冲会略增，
 * 故这是个略偏保守的常数——宁可低估误差，不虚报。
 */
export const GPU_FIXED_OVERHEAD_MB = 620

/** 显存预估（MiB）= 权重 + mmproj + KV + 固定开销；几何缺失时按权重+mmproj+固定开销（下界） */
export function estimateVramMb(
  weightsBytes: number,
  mmprojBytes: number,
  geom: GgufKvGeometry | null,
  ctx: number
): number {
  const kv = geom ? kvBytesF16(geom, ctx) : 0
  return Math.ceil((weightsBytes + mmprojBytes + kv) / (1024 * 1024)) + GPU_FIXED_OVERHEAD_MB
}

/** GGUF 元数据读取器（只读 KV 块，不碰张量数据） */
class GgufReader {
  private readonly fd: number
  private filePos = 0

  constructor(fd: number) {
    this.fd = fd
  }

  /** 精确读 n 字节 */
  readExact(n: number): Buffer | null {
    const out = Buffer.alloc(n)
    let read = 0
    while (read < n) {
      const r = readSync(this.fd, out, read, n - read, this.filePos + read)
      if (r <= 0) return null
      read += r
    }
    this.filePos += n
    return out
  }

  readU32(): number | null {
    const b = this.readExact(4)
    return b ? b.readUInt32LE(0) : null
  }

  readU64(): bigint | null {
    const b = this.readExact(8)
    return b ? b.readBigUInt64LE(0) : null
  }

  readStr(): string | null {
    const len = this.readU64()
    if (len === null) return null
    if (len > BigInt(1 << 20)) return null
    const b = this.readExact(Number(len))
    if (!b) return null
    return b.toString('utf8')
  }

  /**
   * 读一个元数据值；数值型返回 value，其余类型（字符串/数组等）消费字节后返回 null。
   * 返回 null 表示读取失败（整个文件放弃解析）。
   */
  readNum(ty: number): { value: number | null } | null {
    if (ty === 8) {
      // string：消费字节后返回"无数值"
      if (this.readStr() === null) return null
      return { value: null }
    }
    if (ty === 9 || ty === 12) {
      // array / f64 array：逐元素消费
      const elemTy = this.readU32()
      if (elemTy === null) return null
      const len = this.readU64()
      if (len === null || len > BigInt(1 << 20)) return null
      for (let i = 0; i < Number(len); i++) {
        if (this.readNum(elemTy) === null) return null
      }
      return { value: null }
    }
    const size = GGUF_INT_SIZES[ty]
    if (size === undefined) return null
    const b = this.readExact(size)
    if (!b) return null
    // 与 Rust 一致：按小端零填充读成 u64（负数不做符号扩展）
    const padded = Buffer.alloc(8)
    b.copy(padded, 0)
    return { value: Number(padded.readBigUInt64LE(0)) }
  }
}

/** GGUF 整数类型字节宽度（0=u8 1=i8 2=u16 3=i16 4=u32 5=i32 6=f32 7=bool 10=u64 11=i64） */
const GGUF_INT_SIZES: Record<number, number> = {
  0: 1,
  1: 1,
  2: 2,
  3: 2,
  4: 4,
  5: 4,
  6: 4,
  7: 1,
  10: 8,
  11: 8
}

/**
 * 读取 GGUF 的 KV 几何；文件不存在 / 非 GGUF / 缺关键字段 → null（调用方退化为下界估算）。
 *
 * 架构前缀因模型而异（`qwen3vl.` / `qwen3.` / `llama.` …），故按键名**后缀**匹配。
 */
export function readGgufKvGeometry(path: string): GgufKvGeometry | null {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const r = new GgufReader(fd)
    const magic = r.readExact(4)
    if (!magic || magic.toString('ascii') !== 'GGUF') return null
    if (r.readU32() === null) return null // version
    if (r.readU64() === null) return null // n_tensors
    const nKv = r.readU64()
    if (nKv === null) return null

    let layers: number | null = null
    let kvHeads: number | null = null
    let keyLen: number | null = null
    let valLen: number | null = null
    let emb: number | null = null
    let heads: number | null = null

    // 元数据块远小于此上限；防御性截断，避免坏文件把循环拖死
    const count = Math.min(Number(nKv), 8192)
    for (let i = 0; i < count; i++) {
      const key = r.readStr()
      if (key === null) return null
      const ty = r.readU32()
      if (ty === null) return null
      const num = r.readNum(ty)
      if (num === null) return null
      const v = num.value
      if (v === null) continue
      if (key.endsWith('.block_count')) layers = v
      else if (key.endsWith('.attention.head_count_kv')) kvHeads = v
      else if (key.endsWith('.attention.key_length')) keyLen = v
      else if (key.endsWith('.attention.value_length')) valLen = v
      else if (key.endsWith('.embedding_length')) emb = v
      else if (key.endsWith('.attention.head_count')) heads = v
    }

    if (layers === null) return null
    // KV 头数缺失时退化为注意力头数（MHA 模型）
    const kvh = kvHeads ?? heads
    if (kvh === null || kvh <= 0) return null
    let headDim = keyLen ?? valLen
    if (headDim === null && emb !== null && heads !== null && heads > 0) {
      headDim = Math.floor(emb / heads)
    }
    if (headDim === null || headDim <= 0) return null
    return { layers, kvHeads: kvh, headDim }
  } finally {
    closeSync(fd)
  }
}

/**
 * 可用显存 MiB（总 − 已用）。无法判定 → null。
 *
 * 口径：nvidia-smi（memory.total / memory.used），非 NVIDIA / 无驱动 / 无权限 → null。
 */
export async function gpuFreeMb(): Promise<number | null> {
  try {
    const { execFile } = await import('node:child_process')
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        'nvidia-smi',
        ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits'],
        { windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      )
    })
    const first = out.split(/\r?\n/)[0]?.trim() ?? ''
    if (first === '') return null
    const parts = first.split(',').map((s) => s.trim())
    const total = Number.parseInt(parts[0] ?? '', 10)
    const used = Number.parseInt(parts[1] ?? '', 10)
    if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) return null
    return Math.max(0, total - used)
  } catch {
    return null
  }
}

// ─── 引擎状态快照 ─────────────────────────────────────────────────────────

/**
 * 引擎状态快照：`loaded` 判定与 model/device 取自同一次状态读取，
 * 供状态对账使用（避免分三次调用得到撕裂状态）。
 */
export interface LlamaSnapshot {
  loaded: boolean
  model: string
  device: string
}

/** 阶段回调：连续重复的阶段不重复上报（避免 'loading'/'ready' 抖动） */
let lastStage: string | null = null

function emitStage(onStage: AsrStageCallback, stage: string): void {
  if (lastStage === stage) return
  lastStage = stage
  onStage(stage)
}

// ─── 引擎 ─────────────────────────────────────────────────────────────────

/**
 * llama-server 子进程 + HTTP 客户端封装
 *
 * 启动后常驻，每次转写不重启。
 */
export class LlamaServerEngine {
  /** 当前生效配置（显式设置；未设置时懒解析默认配置） */
  private explicitCfg: LlamaServerConfig | null = null
  /** 懒解析后的配置 */
  private resolvedCfg: LlamaServerConfig | null = null
  /** 子进程句柄 + 退出标记 */
  private proc: { child: ChildProcess; exited: boolean } | null = null
  /** 本次加载的子进程 stderr 尾部（失败诊断用，见 withGpuHint） */
  private lastStderr: string[] = []
  /** 本进程最后一次成功 spawn 的配置（用于接管身份验证） */
  private launched: LaunchRec | null = null
  /** 状态快照缓存（同步 isLoaded 读它；后台异步刷新） */
  private snapshotCache: LlamaSnapshot = { loaded: false, model: '', device: '' }

  constructor(config?: LlamaServerConfig) {
    if (config) this.explicitCfg = config
  }

  /** 当前生效配置（懒解析默认配置；解析失败退回最小配置，不 panic） */
  private get cfg(): LlamaServerConfig {
    if (!this.resolvedCfg) {
      this.resolvedCfg = this.explicitCfg ?? defaultLlamaServerConfig()
    }
    return this.resolvedCfg
  }

  /** 显式设置配置（initGlobal 用） */
  setConfig(config: LlamaServerConfig): void {
    this.explicitCfg = config
    this.resolvedCfg = config
  }

  // ── 端口 / 身份验证 ────────────────────────────────────────────────────

  /**
   * 端口探测：任何进程在监听即 true（不判所有权）——仅供端口层（占用/冲突判断）使用。
   * 绝不直接当作"已加载"：那是 isLoaded()（所有权+验证语义）的职责。
   */
  private async portAlive(port: number): Promise<boolean> {
    try {
      const resp = await fetchLoopback(`http://127.0.0.1:${port}${HEALTH_PATH}`, { method: 'GET' }, HEALTH_TIMEOUT)
      return resp.ok
    } catch {
      return false
    }
  }

  /**
   * 端口上的 server 是否「确实是目标模型 + 正确采样 + 本进程以相同配置启动过」。
   * 任一环节无法确认 → false → 走杀重启（保证切换真实生效）。
   */
  async runningMatches(cfg: LlamaServerConfig): Promise<boolean> {
    if (!(await this.portAlive(cfg.port))) return false
    // 1. 模型身份必须一致
    const p = await runningModelPath(cfg.port)
    if (!p || !pathsEqual(p, cfg.modelPath)) return false
    // 2. 采样参数必须一致（temp 0 = greedy；残留默认 temp 0.8 → ASR 随机）
    const t = await runningTemperature(cfg.port)
    if (t === null || Math.abs(t - cfg.temperature) >= 1e-4) return false
    // 3. 必须是本进程以相同配置启动过的（-ngl / mmproj 无法从 /props 验证）
    if (!this.launched) return false
    return launchRecMatches(this.launched, cfg)
  }

  // ── 加载 / 卸载 ────────────────────────────────────────────────────────

  /** 启动子进程 + 等待健康检查通过 */
  async load(): Promise<void> {
    await this.loadWithConfig(this.cfg, () => {})
  }

  /**
   * 用指定配置启动（支持换模型：先 unload 再调本方法）
   * `onStage`: 细粒度加载阶段回调（unload/loading/initializing/ready）
   */
  async loadWithConfig(cfg: LlamaServerConfig, onStage: AsrStageCallback): Promise<void> {
    // 0. 记录新配置（后续转写 / health 用新端口和路径）
    this.setConfig(createLlamaServerConfig(configFields(cfg)))
    // 本轮加载的失败诊断缓冲：清掉上一轮的 stderr 尾巴，避免误判成本轮原因
    this.lastStderr = []

    // 1. 已有 server 在跑：只有「模型 + 采样 + 本进程启动参数」全部验证一致才接管，
    //    否则杀掉重启 —— 杜绝把残留的旧模型/默认采样进程当成目标模型（假成功/整句乱码）。
    if (await this.runningMatches(this.cfg)) {
      log.info(
        `[llama-server] 已在运行且验证一致（模型/采样/启动参数），直接接管: ${this.cfg.modelPath}`
      )
      return
    }
    if (await this.portAlive(this.cfg.port)) {
      const running = await runningModelPath(this.cfg.port)
      log.warn(
        `[llama-server] 端口 ${this.cfg.port} 已有 server 但与目标不一致（运行: ${running ?? '未知'}，目标: ${this.cfg.modelPath}），清理后重启`
      )
      // 清掉本进程残留 child 句柄
      await this.killChild()
      await killPortOwner(this.cfg.port)
      await waitPortClosed(this.cfg.port, 3_000)

      // 外部进程（非本软件引擎，路径判定拒杀）仍占用 → 不杀，自动换空闲端口。
      // 端口对本应用是私有内部值：选定即本会话使用，不回归默认、不反复扫描。
      if (await this.portAlive(this.cfg.port)) {
        const p = await findFreePort(this.cfg.port + 1)
        if (p !== null) {
          log.warn(
            `[llama-server] 端口 ${this.cfg.port} 被外部进程占用（不误杀），改用空闲端口 ${p}`
          )
          this.cfg.port = p
          // 同步回 config：后续 health/转写/身份验证都用新端口
        } else {
          throw new Error(`端口 ${this.cfg.port} 被外部进程占用且无空闲端口可用`)
        }
      }
    }

    // 2. 检查可执行文件 / 模型文件 / mmproj
    if (!existsSync(this.cfg.serverPath)) {
      throw new Error(`llama-server 可执行文件不存在: ${this.cfg.serverPath}`)
    }
    if (!existsSync(this.cfg.modelPath)) {
      throw new Error(`模型文件不存在: ${this.cfg.modelPath}`)
    }
    if (!existsSync(this.cfg.mmprojPath)) {
      throw new Error(`mmproj 文件不存在: ${this.cfg.mmprojPath}`)
    }

    // 3. 启动子进程
    const cfgNow = this.cfg
    log.info(
      `[llama-server] 启动子进程: ${cfgNow.serverPath} -m ${cfgNow.modelPath} --mmproj ${cfgNow.mmprojPath} --port ${cfgNow.port} -ngl ${cfgNow.nGpuLayers} --ctx-size ${cfgNow.ctxSize} --parallel ${cfgNow.parallel} --temp ${cfgNow.temperature}`
    )

    const args: string[] = [
      '-m',
      cfgNow.modelPath,
      '--mmproj',
      cfgNow.mmprojPath,
      '--port',
      String(cfgNow.port),
      '-ngl',
      String(cfgNow.nGpuLayers),
      '--ctx-size',
      String(cfgNow.ctxSize),
      '--parallel',
      String(cfgNow.parallel),
      '--temp',
      String(cfgNow.temperature)
    ]
    if (cfgNow.noWebui) args.push('--no-webui')
    // mmproj 投影塔：跟随设备配置（cuda → GPU，cpu → CPU）
    args.push(cfgNow.mmprojOffload ? '--mmproj-offload' : '--no-mmproj-offload')

    const child = spawn(cfgNow.serverPath, args, {
      windowsHide: true, // 隐藏子进程控制台窗口（仅 Windows）
      stdio: ['ignore', 'ignore', 'pipe']
    })

    // spawn 失败（ENOENT 等）是异步事件 → 必须等 'spawn'/'error' 之一
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (e: Error) => reject(new Error(`spawn llama-server 失败: ${e.message}`)))
    })

    const proc = { child, exited: false }
    this.proc = proc
    child.on('exit', () => {
      proc.exited = true
    })
    child.on('error', (e: Error) => {
      log.warn(`[llama-server] 子进程错误: ${e.message}`)
    })

    // stderr 解析 → 细粒度阶段（读模型/加载投影/初始化）
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr })
      rl.on('line', (line: string) => {
        // 失败诊断：滚动保留最后若干行（显存/GPU 错误特征在最尾部）
        if (this.lastStderr.length >= STDERR_TAIL_LINES) this.lastStderr.shift()
        this.lastStderr.push(line)
        // llama-server 日志 → 通用阶段（框架无关）
        if (line.includes("loading model '") || line.includes('loaded multimodal model')) {
          emitStage(onStage, 'loading')
        } else if (line.includes('initializing, n_slots')) {
          emitStage(onStage, 'initializing')
        } else if (line.includes('model loaded')) {
          emitStage(onStage, 'ready')
        }
      })
    }

    // 4. 等待就绪：必须是「我们 spawn 的子进程还活着」且「端口在服务」
    //    （只查端口会被外部进程抢先占口造成"假就绪"）
    const start = Date.now()
    while (Date.now() - start < READY_TIMEOUT) {
      // 子进程提前退出？
      if (proc.exited) {
        this.proc = null
        // 子进程已退出 ⇒ stderr 管道 EOF，读线程正在收尾；等它把最后几行落进缓冲再判定
        await delay(60)
        throw new Error(
          await this.withGpuHint(
            'llama-server 启动后立即退出：可能端口被外部进程占用，或模型路径/GPU 问题'
          )
        )
      }
      // 端口在服务且子进程存活 → 真就绪
      if (!proc.exited && (await this.portAlive(cfgNow.port))) {
        log.info(`[llama-server] 就绪，耗时 ${Date.now() - start}ms`)
        // 记录本次成功启动的配置（后续 runningMatches 身份验证用）
        this.launched = launchRecFromCfg(cfgNow)
        this.snapshotCache = {
          loaded: true,
          model: basename(cfgNow.modelPath),
          device: cfgNow.nGpuLayers > 0 ? 'cuda' : 'cpu'
        }
        emitStage(onStage, 'ready')
        return
      }
      await delay(POLL_INTERVAL)
    }

    // 超时：清理
    await this.killChild()
    throw new Error(
      await this.withGpuHint(`llama-server 启动超时（${READY_TIMEOUT / 1000}s）`)
    )
  }

  /**
   * 退出路径专用：只终止自己的子进程，**不等它退出、不扫描/清理端口占用**。
   *
   * 进程马上就要结束，这里的等待纯属浪费（`unload()` 会等子进程退出 + 轮询端口最多 3s，
   * 在关窗路径上就是"点了关闭要等好几秒托盘图标才消失"）。端口与显存随进程由 OS 回收；
   * 外部残留占用在下次启动的 `unload()`/加载前照旧会被清理。
   */
  killForExit(): void {
    const proc = this.proc
    this.proc = null
    if (proc) {
      log.info(`[llama-server] 退出：直接终止子进程 PID=${proc.child.pid ?? '?'}`)
      try {
        proc.child.kill()
      } catch {
        // 已经退出 —— 忽略
      }
    }
    this.launched = null
    this.snapshotCache = { loaded: false, model: '', device: '' }
  }

  /** 停止子进程 */
  async unload(): Promise<void> {
    await this.killChild()
    // 兜底：外部启动 / 上次崩溃残留的 llama-server 一并清掉，保证下次 load 干净。
    const port = this.cfg.port
    await killPortOwner(port)
    await waitPortClosed(port, 3_000)
    this.launched = null
    this.snapshotCache = { loaded: false, model: '', device: '' }
  }

  /** 终止子进程并等待其退出（有上限，避免无限等待） */
  private async killChild(): Promise<void> {
    const proc = this.proc
    this.proc = null
    if (!proc) return
    try {
      proc.child.kill()
    } catch {
      // 已经退出 —— 忽略
    }
    if (proc.exited) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 3_000)
      proc.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  // ── 状态 ───────────────────────────────────────────────────────────────

  /**
   * 引擎是否"已加载"（所有权语义）：
   * 仅当 ①本进程成功启动过（launched 记录）且 ②该端口仍在服务时返回 true。
   * 外部进程/用户自装的 llama-server 即使监听同一端口，也不被视为"我们的已加载引擎"。
   *
   * 注：端口探测是 HTTP 往返（异步），这里返回**缓存快照**（同步），
   * 并在后台异步刷新 —— 与 AsrEngine 接口的同步签名保持一致。
   */
  isLoaded(): boolean {
    void this.refreshSnapshot()
    return this.snapshotCache.loaded
  }

  /** 状态快照：`loaded` / 模型文件名 / 设备在一次调用内取齐（与 `isLoaded` 同一实现）。 */
  async snapshot(): Promise<LlamaSnapshot> {
    const snap = await this.computeSnapshot()
    this.snapshotCache = snap
    return snap
  }

  /** 后台刷新状态快照（不阻塞调用方） */
  private async refreshSnapshot(): Promise<void> {
    try {
      this.snapshotCache = await this.computeSnapshot()
    } catch {
      // 诊断失败不影响主流程
    }
  }

  /** 计算状态快照（端口是权威判据：只要 /health 响应 = 引擎在服务 = 已加载） */
  private async computeSnapshot(): Promise<LlamaSnapshot> {
    // 本进程从未成功启动过 → 不是我们的引擎
    if (!this.launched) return { loaded: false, model: '', device: '' }

    const cfg = this.cfg
    const portAlive = await this.portAlive(cfg.port)
    const childSaysAlive = this.proc ? !this.proc.exited : true // 接管场景无 child 句柄
    if (!portAlive) {
      // 端口不通：深度诊断（引擎真死 vs 连接异常）
      const tcpOk = await portServing(cfg.port, 500)
      const freshHealth = await this.freshHealth(cfg.port)
      log.info(
        `[llama-server] is_loaded=false: port=${cfg.port} pooled_health=false tcp=${tcpOk} fresh_health=${freshHealth} child_alive=${childSaysAlive}`
      )
      return { loaded: false, model: '', device: '' }
    }
    // 端口通：即使 child 句柄 stale 也视为已加载（接管/句柄过期场景的正确语义）
    if (!childSaysAlive) {
      log.info(`[llama-server] child 句柄已退出但端口 ${cfg.port} 在服务 → 视为已加载`)
    }
    return {
      loaded: true,
      model: basename(cfg.modelPath),
      device: cfg.nGpuLayers > 0 ? 'cuda' : 'cpu'
    }
  }

  /** 全新连接的健康检查（1500ms 超时） */
  private async freshHealth(port: number): Promise<boolean> {
    try {
      const resp = await fetchLoopback(
        `http://127.0.0.1:${port}${HEALTH_PATH}`,
        { method: 'GET' },
        1_500
      )
      return resp.ok
    } catch {
      return false
    }
  }

  // ── 转写 ───────────────────────────────────────────────────────────────

  /** 转写一段音频（samples: 16kHz 单声道 float32 PCM） */
  async transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
    if (!this.snapshotCache.loaded) throw new Error('llama-server 未初始化')

    // 1. float32 → 原始 WAV 字节（multipart 直接发二进制，不是 base64）
    const wavBytes = encodePcmToWav(samples, sampleRate)

    // 构造 multipart 表单（辅助函数：失败重试时重建）
    const url = this.cfg.transcribeUrl()
    let resp: Response
    try {
      resp = await fetchLoopback(
        url,
        { method: 'POST', body: buildTranscribeForm(wavBytes) },
        TRANSCRIBE_TIMEOUT
      )
    } catch (firstErr) {
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr)
      log.warn(
        `[llama-server] transcribe 首次请求失败（可能连接池 stale），用新连接重试: ${url} — ${msg}`
      )
      try {
        // 重建 multipart 表单（FormData 只能消费一次）+ 全新连接
        resp = await fetchLoopback(
          url,
          { method: 'POST', body: buildTranscribeForm(wavBytes) },
          TRANSCRIBE_TIMEOUT
        )
      } catch (retryErr) {
        throw new Error(
          `HTTP 失败: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
        )
      }
    }

    if (!resp.ok) {
      const status = `${resp.status} ${resp.statusText}`.trim()
      const body = await resp.text().catch(() => '')
      throw new Error(`llama-server 返回 ${status}: ${body}`)
    }

    // 3. 解析响应
    let body: { text?: unknown }
    try {
      body = (await resp.json()) as { text?: unknown }
    } catch (e) {
      throw new Error(`解析响应失败: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (typeof body.text !== 'string') {
      throw new Error('解析响应失败: 响应缺少 text 字段')
    }

    // llama-server 响应里可能包含 language Chinese<asr_text>xxx 这种前缀
    // 提取 <asr_text> 之后的内容
    return extractAsrText(body.text)
  }

  /**
   * 带「上文」的转写：走 chat 端点，把前文文本与音频一起送模型（跨段记忆）。
   *
   * 为什么不用 `/v1/audio/transcriptions`：它只吃一个音频文件、无法附加上文。
   * 实测 `/v1/chat/completions` 接受 `text` + `input_audio` 两个 part，且模型会用上文
   * 纠正接缝处的同音字（「纯电」→「沉淀」）。
   * 任何失败（模型模板不支持 audio part / 解析失败）都回退到无上文的 `transcribe`，
   * 绝不因记忆功能降低可用性。
   */
  async transcribeWithContext(
    samples: Float32Array,
    sampleRate: number,
    ctx: string
  ): Promise<string> {
    const trimmed = ctx.trim()
    if (trimmed === '') return await this.transcribe(samples, sampleRate)
    if (!this.snapshotCache.loaded) throw new Error('llama-server 未初始化')

    const wavBytes = encodePcmToWav(samples, sampleRate)
    const audioB64 = wavBytes.toString('base64')
    // 提示词形状经实测选定：无 system 提示（system 会带偏输出），仅「上文：<前文>」+ 音频。
    const payload = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `上文：${trimmed}` },
            { type: 'input_audio', input_audio: { data: audioB64, format: 'wav' } }
          ]
        }
      ],
      temperature: 0,
      max_tokens: 1024
    }

    try {
      const resp = await fetchLoopback(
        this.cfg.chatUrl(),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        },
        CHAT_TIMEOUT
      )
      if (!resp.ok) {
        const status = `${resp.status} ${resp.statusText}`.trim()
        const text = await resp.text().catch(() => '')
        throw new Error(`llama-server 返回 ${status}: ${text}`)
      }
      const v = (await resp.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>
      }
      const content = v.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new Error('响应缺少 choices[0].message.content')
      return extractAsrText(content)
    } catch (e) {
      log.warn(
        `[llama-server] 带上文转写失败，回退无上文重试: ${e instanceof Error ? e.message : String(e)}`
      )
      return await this.transcribe(samples, sampleRate)
    }
  }

  // ── 其它 ───────────────────────────────────────────────────────────────

  /**
   * 显存预估（MiB）：权重 + mmproj + KV(按 ctx 与 GGUF 几何) + 固定开销。
   *
   * 旧实现取「模型目录大小」——把文件体积当显存，系统性少算 KV + CUDA 上下文（实测差 ~1.3 GiB）。
   */
  vramEstimateMb(): number | null {
    const cfg = this.cfg
    if (cfg.nGpuLayers === 0) return null // 纯 CPU：不占显存
    let weights: number
    try {
      weights = statSync(cfg.modelPath).size
    } catch {
      return null
    }
    let mmproj = 0
    if (cfg.mmprojOffload) {
      try {
        mmproj = statSync(cfg.mmprojPath).size
      } catch {
        mmproj = 0
      }
    }
    const geom = readGgufKvGeometry(cfg.modelPath)
    return estimateVramMb(weights, mmproj, geom, cfg.ctxSize)
  }

  /** 当前 llama-server 子进程 PID（未加载 → null） */
  pid(): number | null {
    return this.proc?.child.pid ?? null
  }

  /** 当前加载的模型文件路径（换模型后同步更新） */
  currentModelPath(): string {
    return this.cfg.modelPath
  }

  /** 当前模型显示名（取真实模型文件名 + 后端标记；此前无论加载什么都显示 0.6B） */
  modelName(): string | null {
    const fname = basename(this.cfg.modelPath)
    if (!fname) return null
    return `${fname} (via llama-server)`
  }

  /** 当前生效设备（cuda/cpu），供状态快照与前端展示 */
  deviceLabel(): string {
    return this.cfg.nGpuLayers > 0 ? 'cuda' : 'cpu'
  }

  /** 本进程当前使用的引擎端口（换口后返回实际端口；未启动时返回配置端口） */
  currentPort(): number {
    return this.cfg.port
  }

  /** 当前生效配置（克隆）——显存预估、诊断用 */
  config(): LlamaServerConfig {
    return createLlamaServerConfig(configFields(this.cfg))
  }

  /**
   * 把 stderr 尾部的 GPU 特征行转成可操作结论并附在失败信息后（无特征则附最后一行）。
   */
  private async withGpuHint(base: string): Promise<string> {
    const tail = [...this.lastStderr]
    const hit = classifyGpuFailure(tail)
    if (hit) {
      if (hit.kind === 'oom') {
        return `${base}。显存不足：GPU 分配失败（需要 ${fmtMb(this.vramEstimateMb())}，当前可用 ${fmtMb(
          await gpuFreeMb()
        )}）——建议改用 CPU 加载，或关闭占显存的程序。llama-server: ${hit.line}`
      }
      return `${base}。GPU 运行错误（可能是驱动/显卡问题）。llama-server: ${hit.line}`
    }
    const last = tail[tail.length - 1]
    if (last !== undefined && last.trim() !== '') {
      return `${base}。llama-server: ${last.trim()}`
    }
    return base
  }
}

// ─── 全局单例 ─────────────────────────────────────────────────────────────

/** 全局 llama-server 引擎（懒解析默认配置，不在 import 时触碰文件系统） */
export let llamaEngine: LlamaServerEngine = new LlamaServerEngine()

/** 是否已经用自定义配置初始化过（对齐 Rust OnceLock：仅第一次有效） */
let globalInitialized = false

/**
 * 最近一次被「显式请求」加载的模型名（来自 loadAsrModelWithStage 的参数，
 * 即用户在 UI 的当前选择）。热键兜底 / 文件转写兜底用它，避免硬编码 0.6B
 * 造成「UI 显示 1.7B、后台实际跑 0.6B」。
 */
let lastRequested: { name: string; device: string } | null = null

/** 获取"最近一次被请求"的 (模型, 设备)（注册表兜底用） */
export function lastRequestedModel(): { name: string; device: string } | null {
  return lastRequested ? { ...lastRequested } : null
}

/** 记录最近一次被请求的 (模型, 设备) —— 任意框架成功路由都应调用 */
export function recordLastRequested(name: string, device: string): void {
  lastRequested = { name, device }
}

/**
 * 加载「最近一次被请求的模型+设备」；无任何请求记录时用默认（Qwen3-ASR-0.6B / cuda）。
 * 供热键兜底 / 文件转写兜底调用：兜底行为与用户在 UI 的选择保持一致。
 *
 * 注：Rust 版走 registry.load_requested_asr（统一路由 + 框架互斥）。
 * Electron 侧目前只有 llama 引擎，就地走 llama 路径；接入 registry 后改为转发。
 */
export async function loadRequested(): Promise<string> {
  const req = lastRequestedModel() ?? { name: 'Qwen3-ASR-0.6B', device: 'cuda' }
  return await loadAsrModelWithStage(req.name, req.device, () => {})
}

/** 按模型名加载 ASR 引擎（llama-server）。 */
export async function loadAsrModel(name: string): Promise<string> {
  return await loadAsrModelWithStage(name, 'cuda', () => {})
}

/**
 * 带阶段回调的加载：onStage 在「卸载旧模型 / 启动进程 / 等待就绪」阶段触发，
 * 供命令层 emit 到前端展示进度。
 * `device`: "cuda"（全 GPU，n_gpu_layers=99）或 "cpu"（全 CPU，n_gpu_layers=0）
 */
export async function loadAsrModelWithStage(
  name: string,
  device: string,
  onStage: AsrStageCallback
): Promise<string> {
  const engine = llamaEngine
  const cfg = llamaConfigForModel(name, device)

  // 会话内端口延续：本进程因外部占用换过口后，后续加载沿用当前实际端口，
  // 避免每次都回默认口探测而在同一进程内重复起第二台 server。
  if (cfg.port === DEFAULT_PORT) {
    const cur = engine.currentPort()
    if (cur !== DEFAULT_PORT && engine.isLoaded()) cfg.port = cur
  }

  // 已加载同模型（含采样/启动参数一致，以「真实运行的 server」为准）→ 直接返回
  if (await engine.runningMatches(cfg)) {
    return engine.modelName() ?? name
  }

  // 换模型：先卸载旧进程（stage 带出旧模型名，便于日志追踪）
  if (engine.isLoaded()) {
    const old = engine.modelName() ?? ''
    emitStage(onStage, old === '' ? 'unload' : `unload:${old}`)
    await engine.unload()
    emitStage(onStage, 'loading')
  } else {
    emitStage(onStage, 'loading')
  }

  await engine.loadWithConfig(cfg, onStage)
  emitStage(onStage, 'ready')
  // 只在成功后记录「最近请求」：装不上的模型不能写进去，
  // 否则热键/文件/API 兜底会反复重试同一个装不上的模型（每次都等满超时）。
  lastRequested = { name, device }
  return engine.modelName() ?? name
}

/**
 * 从描述符解析运行时 + 模型/投影文件路径（模型差异在 spec，本文件无模型名分支）。
 */
export function llamaConfigForModel(name: string, device: string): LlamaServerConfig {
  const spec = findSpec(name)
  if (!spec) throw new Error(`未知模型: ${name}`)
  if (spec.backend.type !== 'llama') {
    throw new Error(`${name} 不是 llama 后端模型（backend=${spec.backend.type}）`)
  }

  // 目录 = modelDir(name)（内部处理 engine_dir：如 "Qwen3-ASR-0.6B" → "qwen3-asr-0.6b-gguf"）
  const dir = modelDir(name)
  // 主模型文件 / mmproj 一律按该模型的**精选条目**声明取值（不再按文件存在性猜）
  const modelPath = mainModelFile(spec, dir)
  if (!modelPath) {
    const entryId = activeEntryOf(spec)?.id ?? '-'
    throw new Error(`在 ${dir} 未找到主模型文件（条目 ${entryId}）`)
  }
  const mmprojPath = mmprojFile(spec, dir)
  if (!mmprojPath) {
    const entryId = activeEntryOf(spec)?.id ?? '-'
    throw new Error(`在 ${dir} 未找到 mmproj 文件（条目 ${entryId}）`)
  }

  const runtime = llamaRuntimeDir()
  const isCpu = device.toLowerCase().trim() === 'cpu'
  return createLlamaServerConfig({
    serverPath: join(runtime, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
    modelPath,
    mmprojPath,
    port: DEFAULT_PORT,
    // 设备生效：cpu → 全 CPU（0 层）；其他（cuda 等）→ 全 GPU（99 层）
    nGpuLayers: isCpu ? 0 : 99,
    // ctx 由「最长单段请求」定，不是越大越好：KV cache 在**加载时**按 ctx 整块分配，
    // 与模型大小无关（Qwen3 全系 28 层 × 8 KV 头 × 128 维 = 112 KiB/token，见 vram 账目）。
    // 分段上限 68s（60s+8s 重叠）× 13.2 token/s ≈ 900 token + 输出，2048 留 1.7× 余量。
    // 实测（RTX 4070 Laptop，0.6B Q8 + Q8 mmproj，-ngl 99）：
    // ctx8192 = 2488 MiB / ctx4096 = 1994 / ctx2048 = 1768 ⇒ 8192 白占 672 MiB。
    ctxSize: DEFAULT_CTX_SIZE,
    parallel: 1,
    temperature: 0,
    noWebui: true,
    mmprojOffload: !isCpu
  })
}

/** 归一化：大小写不敏感 + 去掉 - 和 _（"Kokoro-v1_0" → "kokorov10"） */
function norm(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, '')
}

/**
 * 按别名查找模型描述符：精确 id > 归一化 id > 归一化目录名（id）> 归一化展示名。
 * 接受前端展示名（Kokoro-v1_0）、引擎 id（kokoro-v1_0）、引擎目录名（kokoro-multi-lang-v1_0）。
 */
function findSpec(input: string): ModelSpec | undefined {
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
  const prefix = input.split(/[^a-zA-Z0-9]/)[0]?.toLowerCase() ?? ''
  if (prefix !== '') {
    for (const m of SPECS) {
      if (norm(m.id).startsWith(prefix)) return m
    }
  }
  return undefined
}

/** 默认配置（从描述符解析默认 ASR 模型 Qwen3-ASR-0.6B；解析失败退回最小配置，不 panic） */
export function defaultLlamaServerConfig(): LlamaServerConfig {
  try {
    return llamaConfigForModel('Qwen3-ASR-0.6B', 'cuda')
  } catch {
    const runtime = llamaRuntimeDir()
    return createLlamaServerConfig({
      serverPath: join(runtime, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
      modelPath: '',
      mmprojPath: '',
      port: DEFAULT_PORT,
      nGpuLayers: 99,
      ctxSize: DEFAULT_CTX_SIZE,
      parallel: 1,
      temperature: 0,
      noWebui: true,
      mmprojOffload: true
    })
  }
}

/** 用自定义配置初始化（仅第一次有效） */
export function initGlobal(config: LlamaServerConfig): LlamaServerEngine {
  if (globalInitialized) return llamaEngine
  globalInitialized = true
  llamaEngine = new LlamaServerEngine(config)
  return llamaEngine
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────

/** 构造 multipart 表单（response_format=json + file 部分） */
function buildTranscribeForm(wav: Buffer): FormData {
  const form = new FormData()
  form.append('response_format', 'json')
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
  return form
}

/** 把 samples 编码为原始 WAV 字节（multipart 直接发送二进制） */
export function encodePcmToWav(samples: Float32Array, sampleRate: number): Buffer {
  const channels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)
  const dataSize = samples.length * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // PCM fmt chunk 大小
  buf.writeUInt16LE(1, 20) // audio format = PCM
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(bitsPerSample, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples.length; i++) {
    // 限幅 + 量化（与 Rust 一致：截断取整，-1 → -32767）
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.trunc(s * 32767), 44 + i * 2)
  }
  return buf
}

/**
 * 从 llama-server 输出中提取纯文本
 * 输入示例：`"language Chinese<asr_text>今天下午三点开会。"` 或 `"今天下午三点开会。"`
 */
export function extractAsrText(raw: string): string {
  const start = raw.indexOf('<asr_text>')
  if (start >= 0) {
    const after = raw.slice(start + '<asr_text>'.length)
    // 截到 < 或字符串末尾
    const end = after.indexOf('<')
    if (end >= 0) return after.slice(0, end).trim()
    return after.trim()
  }
  // 去掉 "language Chinese" 前缀
  const pos = raw.indexOf('language ')
  if (pos >= 0) {
    // 找第一个 "Chinese" 或 "English" 之后（即第一个非 ASCII 字母处）
    const rest = raw.slice(pos + 9)
    const m = rest.match(/[^A-Za-z]/)
    if (m && m.index !== undefined) {
      return raw.slice(pos + 9 + m.index).trim()
    }
  }
  return raw.trim()
}

/**
 * 查询端口上已运行 server 实际加载的模型路径（llama-server 的 GET /props → model_path）
 */
export async function runningModelPath(port: number): Promise<string | null> {
  try {
    const resp = await fetchLoopback(`http://127.0.0.1:${port}/props`, { method: 'GET' }, HEALTH_TIMEOUT)
    if (!resp.ok) return null
    const v = (await resp.json()) as { model_path?: unknown; model?: unknown }
    const p = typeof v.model_path === 'string' ? v.model_path : typeof v.model === 'string' ? v.model : null
    if (p === null) return null
    return existsSync(p) ? p : null
  } catch {
    return null
  }
}

/**
 * 查询已运行 server 的解码温度（/props.default_generation_settings.params.temperature）。
 * 用于识别"残留进程是默认采样（temp 0.8）→ ASR 输出随机/整句乱码"的情况。
 */
export async function runningTemperature(port: number): Promise<number | null> {
  try {
    const resp = await fetchLoopback(`http://127.0.0.1:${port}/props`, { method: 'GET' }, HEALTH_TIMEOUT)
    if (!resp.ok) return null
    const v = (await resp.json()) as {
      default_generation_settings?: { params?: { temperature?: unknown } }
    }
    const t = v.default_generation_settings?.params?.temperature
    return typeof t === 'number' ? t : null
  } catch {
    return null
  }
}

// ─── AsrEngine 适配器（注册到 registry） ─────────────────────────────────

/**
 * llama-server 的 AsrEngine 适配：包装现有全局单例，供 registry 统一路由。
 * 新增 PyTorch 引擎时照此模式写一个 adapter 即可，无需改动上层。
 */
export class LlamaAsrAdapter implements AsrEngine {
  private readonly engine: LlamaServerEngine

  constructor(engine: LlamaServerEngine = llamaEngine) {
    this.engine = engine
  }

  framework(): string {
    return 'gguf'
  }

  async loadModel(name: string): Promise<void> {
    await loadAsrModel(name)
  }

  async loadModelWithDevice(name: string, device: string): Promise<void> {
    await loadAsrModelWithStage(name, device, () => {})
  }

  async loadModelWithStage(name: string, onStage: AsrStageCallback): Promise<void> {
    await loadAsrModelWithStage(name, 'cuda', onStage)
  }

  async loadModelWithStageAndDevice(
    name: string,
    device: string,
    onStage: AsrStageCallback
  ): Promise<void> {
    await loadAsrModelWithStage(name, device, onStage)
  }

  async unload(): Promise<void> {
    await this.engine.unload()
  }

  isLoaded(): boolean {
    return this.engine.isLoaded()
  }

  currentModel(): string {
    return this.engine.modelName() ?? ''
  }

  async transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
    return await this.engine.transcribe(samples, sampleRate)
  }

  async transcribeWithContext(
    samples: Float32Array,
    sampleRate: number,
    ctx: string
  ): Promise<string> {
    return await this.engine.transcribeWithContext(samples, sampleRate, ctx)
  }

  pid(): number | null {
    return this.engine.pid()
  }

  vramEstimateMb(): number | null {
    // 单一实现在内层引擎（加载失败诊断也要用同一份数字）
    return this.engine.vramEstimateMb()
  }
}
