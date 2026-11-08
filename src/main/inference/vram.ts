/**
 * 显存账目：GGUF 几何 → KV cache 精确字节数 → 显存预估
 *
 * ── 对齐 Rust 版 `src-tauri/src/vram.rs`（1:1 移植；注释保留原意并译为中文）──
 *
 * ## 为什么需要
 * 模型卡片显示的「体积」是**磁盘文件体积**，而实际显存 = 权重 + **KV cache**（llama.cpp 在
 * 加载时按 `--ctx-size` **整块**分配，与模型大小无关）+ 计算缓冲 + CUDA 上下文。
 * 本机实测（RTX 4070 Laptop，0.6B Q8 + Q8 mmproj，`-ngl 99`）：
 * ctx 8192 = 2488 MiB、ctx 4096 = 1994 MiB、ctx 2048 = 1768 MiB
 * ⇒ 只有把 KV 与进程固定开销一起算进去，界面上的数字才不骗人。
 *
 * ## 口径
 * - **权重 / mmproj**：直接用文件字节数（量化权重驻留显存时就是文件大小）。
 * - **KV**：从 GGUF 元数据读几何（层数 / KV 头数 / head_dim）后精确计算，不猜。
 * - **固定开销**：CUDA 上下文 + cuBLAS 工作区 + 计算缓冲，取本机实测常数（见下）。
 * - 真值（驱动口径）由**引擎自报**给出（进程内 FFI 引擎读设备显存加载前后差值）；
 *   本模块负责**可预测的预估值**，作为无法自报时的兜底。
 */

import { spawn } from 'node:child_process'
import { closeSync, openSync, readSync, statSync } from 'node:fs'

/**
 * 进程级固定开销（CUDA 上下文 + cuBLAS 工作区 + 计算缓冲），MiB。
 *
 * 实测口径：驱动真值 −（权重 + mmproj + KV）≈ 620 MiB，且在 ctx 8192/4096/2048 三档一致
 * （0.6B Q8 + Q8 mmproj，RTX 4070 Laptop，`-ngl 99`）。模型越大计算缓冲会略增，
 * 故这是个略偏保守的常数——宁可低估误差，不虚报。
 */
export const GPU_FIXED_OVERHEAD_MB = 620

/**
 * GGUF 的 KV 几何（只取算 KV cache 需要的三项）
 */
export interface GgufKvGeometry {
  /** 层数（`*.block_count`） */
  layers: number
  /** KV 头数（`*.attention.head_count_kv`） */
  kvHeads: number
  /** 每头维度（`*.attention.key_length`，缺失时用 value_length 或 embedding_length/head_count 推） */
  headDim: number
}

/** f16 KV cache 字节数 = ctx × 2(K+V) × layers × kv_heads × head_dim × 2B */
export function kvBytesF16(geom: GgufKvGeometry, ctx: number): number {
  return ctx * 2 * geom.layers * geom.kvHeads * geom.headDim * 2
}

/**
 * 显存预估（MiB）= 权重 + mmproj + KV + 固定开销。
 * `geom` 缺失（读不到 GGUF）时按权重+mmproj+固定开销算，即**下界**。
 */
export function estimateVramMb(
  weightsBytes: number,
  mmprojBytes: number,
  geom: GgufKvGeometry | null,
  ctx: number
): number {
  const kv = geom ? kvBytesF16(geom, ctx) : 0
  return Math.ceil((weightsBytes + mmprojBytes + kv) / (1024 * 1024)) + GPU_FIXED_OVERHEAD_MB
}

// ─── 驱动口径：总/已用/可用显存 ─────────────────────────────────────────────
//
// 预估（上面）用于「需要多少」；本段用于「还剩多少」。两者都只做**读**，
// 判定与放行策略在调用方（见 `model_manager::checkLoadVram`）。

/**
 * 跑一条外部命令（隐藏控制台窗口；失败一律返回 ok=false，不抛）。
 *
 * ## 必须是异步的
 * Rust 版用同步 `Command::output()`，这里如果照抄成 `spawnSync`：
 *   - `nvidia-smi` 约 0.1s —— 尚可
 *   - **PowerShell + WMI 查询约 3.3s**（实测）—— 主线程被占住 3.3s，
 *     期间渲染进程收不到任何 IPC ⇒ 点击标签/按钮明显卡一下、
 *     窗口被 Windows 判为「未响应」（AppHang）。
 * 所以全部改成 `spawn` + Promise，主线程只等 IO 不等进程。
 */
function runCommand(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean, stdout: string): void => {
      if (settled) return
      settled = true
      resolve({ ok, stdout })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      finish(false, '')
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    child.stdout?.on('data', (c: Buffer) => {
      size += c.length
      // 8MB 上限（与原同步实现的 maxBuffer 一致）
      if (size > 8 * 1024 * 1024) {
        try {
          child.kill()
        } catch {
          /* 已退出 */
        }
        finish(false, '')
        return
      }
      chunks.push(c)
    })
    child.on('error', () => finish(false, ''))
    child.on('close', (code) => finish(code === 0, Buffer.concat(chunks).toString('utf-8')))
    // 15 秒超时（与原同步实现的 timeout 一致）
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      finish(false, '')
    }, 15_000)
  })
}

/**
 * 带 TTL 缓存 + 单飞（single-flight）的异步结果。
 *
 * - **TTL**：结果在有效期内直接复用，不再起外部命令。
 * - **单飞**：并发调用共享同一个 in-flight Promise，只跑一次外部命令。
 */
function cachedAsync<T>(
  fn: () => Promise<T>,
  ttlMs: number
): () => Promise<T> {
  let cached: { value: T; at: number } | null = null
  let inflight: Promise<T> | null = null
  return async (): Promise<T> => {
    const now = Date.now()
    if (cached && now - cached.at < ttlMs) return cached.value
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const value = await fn()
        cached = { value, at: Date.now() }
        return value
      } finally {
        inflight = null
      }
    })()
    return inflight
  }
}

/**
 * 外部命令本身也有主线程开销 —— 不只是「阻塞」问题。
 *
 * Windows 上每次 `child_process.spawn` 都要在主线程里同步走一次 CreateProcess：
 * 几毫秒起步，装了杀软/EDR 的机器能到几十毫秒。所以即便已经改成异步，
 * **每 10 秒打一轮 nvidia-smi + PowerShell 仍会周期性地让点击卡一下**
 * （异步只保证不长时间占住，不保证没有成本）。
 * 因此每个查询都挂 TTL + 单飞：同一时刻最多一条命令在跑，结果还能被后续轮询复用。
 */

/** GPU 静态信息（型号 / 总显存）：进程生命周期内不变 → 60s 缓存 */
const gpuInfoCached = cachedAsync(() => detectGpu(), 60_000)

/** 已用显存：会变，但不必每次轮询都问驱动 → 20s 缓存（> 前端 15s 轮询 ⇒ 通常隔轮才真查一次） */
const smiUsedCached = cachedAsync(() => smiUsedMb(), 20_000)

/**
 * 解析 `nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits` 的首行数字（MiB）。
 * 纯函数（单测锁格式）；解析失败 → null。
 */
export function parseSmiUsedMb(stdout: string): number | null {
  const first = stdout.split(/\r?\n/)[0]
  if (first === undefined) return null
  const trimmed = first.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const v = Number(trimmed)
  return Number.isFinite(v) ? v : null
}

/** nvidia-smi 查询「已用显存」MiB。读不到（非 NVIDIA / 无驱动 / 无权限）→ null。 */
export async function smiUsedMb(): Promise<number | null> {
  const out = await runCommand('nvidia-smi', [
    '--query-gpu=memory.used',
    '--format=csv,noheader,nounits'
  ])
  if (!out.ok) return null
  return parseSmiUsedMb(out.stdout)
}

/** GPU 信息（对应 Rust `sidecar::detect_gpu` / Tauri 命令 `get_gpu_info`） */
export interface GpuInfo {
  available: boolean
  gpuName: string
  memoryMB: number
  source: string
}

/**
 * Rust 直接检测 GPU：调 nvidia-smi（<100ms，零依赖）
 */
export async function detectGpu(): Promise<GpuInfo> {
  const out = await runCommand('nvidia-smi', [
    '--query-gpu=name,memory.total',
    '--format=csv,noheader,nounits'
  ])
  if (!out.ok) {
    return { available: false, gpuName: '', memoryMB: 0, source: 'nvidia-smi' }
  }
  const first = out.stdout.split(/\r?\n/)[0]
  if (first === undefined || first.trim() === '') {
    return { available: false, gpuName: '', memoryMB: 0, source: 'nvidia-smi' }
  }
  const parts = first.split(',').map((s) => s.trim())
  const name = parts[0] ?? ''
  const memRaw = parts[1]
  const mem = memRaw !== undefined && /^\d+$/.test(memRaw) ? Number(memRaw) : 0
  return { available: true, gpuName: name, memoryMB: mem, source: 'nvidia-smi' }
}

/** 前端查询 GPU 信息（对应 Rust Tauri 命令 `get_gpu_info`）：走 60s 缓存 + 单飞 */
export async function getGpuInfo(): Promise<GpuInfo> {
  return gpuInfoCached()
}

/**
 * 驱动口径的 (总显存 MiB, 已用 MiB)。任一读不到 → null。
 *
 * 调用方拿到 null 必须 **fail-open**（显存预检只是提醒，绝不误拦加载）。
 */
export async function gpuMemMb(): Promise<[number, number] | null> {
  const total = (await gpuInfoCached()).memoryMB
  const used = await smiUsedCached()
  if (used === null) return null
  return total > 0 ? [total, used] : null
}

/** 可用显存 MiB（总 − 已用）。无法判定 → null。 */
export async function gpuFreeMb(): Promise<number | null> {
  const mem = await gpuMemMb()
  if (!mem) return null
  const [total, used] = mem
  return Math.max(0, total - used)
}

// ─── GGUF 元数据读取（只读 KV 块，不碰张量数据）──────────────────────────────

/** 严格 UTF-8 解码（Rust 的 `String::from_utf8` 对非法序列直接失败） */
const utf8Strict = new TextDecoder('utf-8', { fatal: true })

/**
 * GGUF 元数据读取的块大小：一次 pread 取一块，解析只在内存里移动游标。
 *
 * 为什么必须成块读：旧实现每个字段一次 `readSync`。Qwen3-ASR 的 GGUF 元数据里
 * 有十几万个 tokenizer 词条（字符串数组），逐字段读 = 上百万次 syscall。
 * 本机实测（0.6B Q8）：读一次 KV 几何 **7.2 秒**，而且这段是同步跑在 Electron
 * 主线程上的 ⇒ 点一下模型页/启动时整个窗口卡死（AppHang 的真凶之一，不是感觉）。
 */
const GGUF_READ_CHUNK = 256 * 1024

/** GGUF 标量类型字节宽度（0=u8 1=i8 2=u16 3=i16 4=u32 5=i32 6=f32 7=bool 10=u64 11=i64 12=f64） */
const GGUF_SCALAR_SIZES: Record<number, number> = {
  0: 1,
  1: 1,
  2: 2,
  3: 2,
  4: 4,
  5: 4,
  6: 4,
  7: 1,
  10: 8,
  11: 8,
  12: 8
}

/** GGUF 元数据读取器（成块缓冲 + 可整块跳过值，不在大数组上逐元素解码） */
class GgufReader {
  private pos = 0
  private buf: Buffer = Buffer.alloc(0)
  private bufStart = 0

  constructor(private readonly fd: number) {}

  /** 取当前游标位置起 n 字节的视图（必要时从文件补一块） */
  private view(n: number): Buffer | null {
    const rel = this.pos - this.bufStart
    if (rel < 0 || rel + n > this.buf.length) {
      const chunk = Math.max(n, GGUF_READ_CHUNK)
      const b = Buffer.allocUnsafe(chunk)
      let got = 0
      try {
        got = readSync(this.fd, b, 0, chunk, this.pos)
      } catch {
        return null
      }
      if (got < n) return null
      this.buf = b.subarray(0, got)
      this.bufStart = this.pos
      return this.buf.subarray(0, n)
    }
    return this.buf.subarray(rel, rel + n)
  }

  /** 读 n 字节；不足 → null（对应 Rust `read_exact` 的 Err） */
  readBytes(n: number): Buffer | null {
    if (n === 0) return Buffer.alloc(0)
    const v = this.view(n)
    if (!v) return null
    this.pos += n
    return v
  }

  /** 跳过 n 字节（只挪游标，不读内容） */
  private skipBytes(n: number): boolean {
    if (!Number.isFinite(n) || n < 0) return false
    this.pos += n
    return true
  }

  readU32(): number | null {
    const b = this.readBytes(4)
    return b ? b.readUInt32LE(0) : null
  }

  /** 读 u64 并收敛到安全整数范围（越界 → null） */
  readU64(): number | null {
    const b = this.readBytes(8)
    if (!b) return null
    const v = b.readBigUInt64LE(0)
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null
  }

  readStr(): string | null {
    const len = this.readU64()
    if (len === null || len > 1 << 20) return null
    const b = this.readBytes(len)
    if (!b) return null
    try {
      return utf8Strict.decode(b)
    } catch {
      return null
    }
  }

  /** 读标量数值（零填充到 8 字节后按小端解释，与 Rust 口径一致） */
  readScalar(size: number): number | null {
    const raw = this.readBytes(size)
    if (!raw) return null
    const padded = Buffer.alloc(8)
    raw.copy(padded, 0)
    const v = padded.readBigUInt64LE(0)
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null
  }

  /**
   * 跳过一个元数据值（字符串 / 数组 / 标量），**不解码内容**。
   *
   * 性能关键：tokenizer 词表/合并表是十几万个字符串的数组，逐元素 decode 既慢又没必要
   * —— 我们要的几何信息全是标量。
   */
  skipValue(ty: number): boolean {
    // string
    if (ty === 8) {
      const len = this.readU64()
      return len !== null && this.skipBytes(len)
    }
    // array / array of f64
    if (ty === 9 || ty === 12) {
      const elemTy = this.readU32()
      if (elemTy === null) return false
      const len = this.readU64()
      if (len === null) return false
      const es = GGUF_SCALAR_SIZES[elemTy]
      if (es !== undefined) return this.skipBytes(len * es)
      // 数组套字符串 / 数组套数组：逐元素推进长度即可（仍在内存里，不做 decode）
      if (elemTy === 8) {
        for (let i = 0; i < len; i++) {
          const l = this.readU64()
          if (l === null || !this.skipBytes(l)) return false
        }
        return true
      }
      if (elemTy === 9 || elemTy === 12) {
        for (let i = 0; i < len; i++) if (!this.skipValue(elemTy)) return false
        return true
      }
      return false
    }
    const size = GGUF_SCALAR_SIZES[ty]
    return size !== undefined && this.skipBytes(size)
  }
}

/** 几何信息关心的键分类（后缀匹配；架构前缀因模型而异） */
function geometryKeyOf(key: string): 'layers' | 'kvHeads' | 'keyLen' | 'valLen' | 'emb' | 'heads' | null {
  if (key.endsWith('.block_count')) return 'layers'
  if (key.endsWith('.attention.head_count_kv')) return 'kvHeads'
  if (key.endsWith('.attention.key_length')) return 'keyLen'
  if (key.endsWith('.attention.value_length')) return 'valLen'
  if (key.endsWith('.embedding_length')) return 'emb'
  if (key.endsWith('.attention.head_count')) return 'heads'
  return null
}

/**
 * 读取 GGUF 的 KV 几何；文件不存在 / 非 GGUF / 缺关键字段 → null（调用方退化为下界估算）。
 *
 * 架构前缀因模型而异（`qwen3vl.` / `qwen3.` / `llama.` …），故按键名**后缀**匹配：
 * `qwen3vl.block_count` 与 `qwen3.block_count` 都命中 `.block_count`；
 * 但 `…attention.head_count_kv` 必须先于 `…attention.head_count` 判定（否则 KV 头数会被误当普通头数）。
 */
export function readGgufKvGeometry(filePath: string): GgufKvGeometry | null {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return null
  }
  try {
    const r = new GgufReader(fd)
    const magic = r.readBytes(4)
    if (!magic || magic.toString('latin1') !== 'GGUF') return null
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
    const limit = Math.min(nKv, 8192)
    for (let i = 0; i < limit; i++) {
      const key = r.readStr()
      if (key === null) return null
      const ty = r.readU32()
      if (ty === null) return null
      const which = geometryKeyOf(key)
      const scalarSize = GGUF_SCALAR_SIZES[ty]
      if (which === null || scalarSize === undefined) {
        // 不关心的键（tokenizer 大数组等）→ 整块跳过，不逐元素解码
        if (!r.skipValue(ty)) return null
        continue
      }
      const v = r.readScalar(scalarSize)
      if (v === null) return null
      if (which === 'layers') layers = v
      else if (which === 'kvHeads') kvHeads = v
      else if (which === 'keyLen') keyLen = v
      else if (which === 'valLen') valLen = v
      else if (which === 'emb') emb = v
      else heads = v
      // 注意：这里**不做早停**。Qwen3-ASR 这类"文本解码器 + 音频编码器"的模型里，
      // 两层架构的 key_length 不一样（实测 0.6B：先出现 64，文本层 128）；
      // 早停会读到音频编码器的值，KV 显存就算错。旧口径是"后出现的覆盖前面的"，保持一致。
    }

    if (layers === null) return null
    // KV 头数缺失时退化为注意力头数（MHA 模型）
    const kv = kvHeads ?? heads
    if (kv === null || kv <= 0) return null
    let headDim: number | null = keyLen ?? valLen
    if (headDim === null && emb !== null && heads !== null) {
      headDim = heads > 0 ? Math.floor(emb / heads) : 0
    }
    if (headDim === null || headDim <= 0) return null
    return { layers, kvHeads: kv, headDim }
  } finally {
    closeSync(fd)
  }
}

/** 几何解析结果缓存项（带文件指纹，文件被替换后自动失效） */
interface GeometryCacheEntry {
  size: number
  mtimeMs: number
  geom: GgufKvGeometry | null
}

/** 缓存上限（模型数量有限，超了整体清空，简单且不会泄漏） */
const GEOMETRY_CACHE_LIMIT = 32

const geometryCache = new Map<string, GeometryCacheEntry>()

/**
 * 读取（并缓存）GGUF 的 KV 几何。
 *
 * 为什么需要缓存：`list_models` 会给**每个已安装条目**算显存预估，
 * 模型页刷新 / 启动 / 下载完成都会触发；同一份 GGUF 会被反复解析。
 * 单次解析即使优化后仍有几十毫秒，缓存后只有首次付代价。
 *
 * 指纹取 (size, mtime)：重新下载/替换模型文件后缓存自然失效，不会读到旧几何。
 */
export function readGgufKvGeometryCached(filePath: string): GgufKvGeometry | null {
  let size: number
  let mtimeMs: number
  try {
    const st = statSync(filePath)
    size = st.size
    mtimeMs = st.mtimeMs
  } catch {
    return null
  }
  const hit = geometryCache.get(filePath)
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.geom
  const geom = readGgufKvGeometry(filePath)
  if (geometryCache.size >= GEOMETRY_CACHE_LIMIT) geometryCache.clear()
  geometryCache.set(filePath, { size, mtimeMs, geom })
  return geom
}

// ─── 各框架显存占用（按 PID 过滤）──────────────────────────────────────────
//
// 真值优先：**我们自己的子进程 PID**（精确）→ 按进程名求和（可能含残留/同名实例）
// → nvidia-smi（其他平台）→ 预估（标注 estimate）。

/** 框架 → 显存占用来源（进程名）；由 `model_manager` 注入（避免两个模块互相 import 成环） */
export interface FrameworkGpuSource {
  /** 引擎注册键（"gguf" | "onnx" | "sherpa" | "pytorch"） */
  id: string
  /** 前端展示名（分组 / 标签 / 显存 JSON key）："llama" | "sherpa" | "torch" */
  engine: string
  /** 常驻进程名（null = 无常驻进程） */
  processName: string | null
}

/** 注入的框架清单（默认空：没有框架就没有 per-framework 明细） */
let frameworkSources: readonly FrameworkGpuSource[] = []

/**
 * 注入框架清单（`model_manager.FRAMEWORKS`）。
 *
 * 为什么用注入而不是直接 import：`model_manager` 需要本模块的显存预估（形成依赖），
 * 直接 import 会造成循环依赖；注入后两侧都只依赖单向，行为不变。
 */
export function setFrameworkGpuSources(sources: readonly FrameworkGpuSource[]): void {
  frameworkSources = sources
}

/** 推理引擎注册表提供的运行时钩子（由主进程入口注入；不注入则只有估算值） */
export interface VramRuntimeHooks {
  /** 某框架当前子进程 PID（精确来源） */
  enginePid?: (frameworkId: string) => number | null
  /** 某框架引擎**自报**的显存占用（MiB，真值来源） */
  engineVramMb?: (frameworkId: string) => number | null
  /** 某框架 active 时的估算显存（MiB；引擎已卸载自动排除） */
  activeEngineVramMb?: (frameworkId: string) => number | null
  /**
   * 当前是否**有任意引擎常驻**（ASR/TTS 任一已加载）。
   *
   * 显存面板的 per-framework 明细只对「正在跑的引擎」有意义；空闲时查询纯属浪费。
   */
  anyActive?: () => boolean
}

let runtimeHooks: VramRuntimeHooks | null = null

/** 注入推理引擎注册表钩子（注册表落地后调用；不注入则跳过这两条来源） */
export function setVramRuntimeHooks(hooks: VramRuntimeHooks | null): void {
  runtimeHooks = hooks
}

/** 显存状态（对应 Rust Tauri 命令 `get_vram_status` 的返回形状） */
export interface VramStatus {
  available: boolean
  gpu_name: string
  total_mb: number
  used_mb: number
  /** 框架 id → 占用（未加载不出现）。source：engine=引擎自报真值 / estimate=预估 */
  frameworks: Record<string, { mb: number; source: string }>
}

/**
 * 查询显存状态：总显存 + 已用 + 各推理框架占用。
 *
 * 成本控制（这是「点按钮偶尔卡一下」的关键）：
 *  - 总显存 / 已用显存走 TTL 缓存 + 单飞（nvidia-smi 每次仍是 CreateProcess）；
 *  - **空闲（没有任何引擎常驻）时根本不查 WMI**：没有框架占用可报，却要付
 *    一次 3.3s 的 PowerShell 和主线程 CreateProcess 开销；
 *  - 只有引擎确实在跑、且 WMI 真值拿不到时，才退回 nvidia-smi 按进程名查
 *    （它要额外起 2 个进程，不能每轮都跑）。
 *
 * 关键：引擎已卸载 / 进程已释放时绝不能回退到"模型目录大小"估算——
 * 那会在引擎死后假报占用。只有引擎 is_loaded()（子进程活着）却查不到
 * 驱动明细（无权限）时，才用注册表估算。
 */
export async function getVramStatus(): Promise<VramStatus> {
  // 静态信息与已用显存：都走缓存（60s / 3s），同一次刷新只起必要的命令
  const gpu = await gpuInfoCached()
  const usedMb = (await smiUsedCached()) ?? 0

  const byEngine = new Map<string, { mb: number; source: string }>()
  for (const fw of frameworkSources) {
    let hit: { mb: number; source: string } | undefined
    // 1) 引擎自报（真值）：进程内 FFI 引擎读设备显存的加载前后差值，
    //    直接回答"我占了多少"—— 不必去查别的进程（旧的 WMI/PowerShell 路线一次 3.3s）
    const self = runtimeHooks?.engineVramMb?.(fw.id) ?? null
    if (self !== null) hit = { mb: self, source: 'engine' }
    // 2) 注册表估算（引擎在跑、但无法自报时的兜底）
    if (!hit) {
      const mb = runtimeHooks?.activeEngineVramMb?.(fw.id) ?? null
      if (mb !== null) hit = { mb, source: 'estimate' }
    }
    if (hit) byEngine.set(fw.engine, hit) // 非空覆盖（同一展示名可能对应多个注册键）
  }

  // Rust 用 BTreeMap（按键有序）→ 这里按 key 排序输出，保证 JSON 顺序一致
  const frameworks: Record<string, { mb: number; source: string }> = {}
  for (const key of Array.from(byEngine.keys()).sort()) {
    const v = byEngine.get(key)
    if (v) frameworks[key] = v
  }

  return {
    available: gpu.available,
    gpu_name: gpu.gpuName,
    total_mb: gpu.memoryMB,
    used_mb: usedMb,
    frameworks
  }
}
