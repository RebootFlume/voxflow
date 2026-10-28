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
 * - 真值（驱动口径）由本模块的「按进程查询」（WMI 计数器）给出；本模块负责**可预测的预估值**。
 */

import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readSync } from 'node:fs'

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

/** 跑一条外部命令（隐藏控制台窗口；失败一律返回 ok=false，不抛） */
function runCommand(cmd: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const res = spawnSync(cmd, args, {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024
    })
    if (res.error) return { ok: false, stdout: '' }
    return { ok: res.status === 0, stdout: res.stdout ?? '' }
  } catch {
    return { ok: false, stdout: '' }
  }
}

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
export function smiUsedMb(): number | null {
  const out = runCommand('nvidia-smi', [
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
export function detectGpu(): GpuInfo {
  const out = runCommand('nvidia-smi', [
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

/** 前端同步查询 GPU 信息（对应 Rust Tauri 命令 `get_gpu_info`） */
export function getGpuInfo(): GpuInfo {
  return detectGpu()
}

/**
 * 驱动口径的 (总显存 MiB, 已用 MiB)。任一读不到 → null。
 *
 * 调用方拿到 null 必须 **fail-open**（显存预检只是提醒，绝不误拦加载）。
 */
export function gpuMemMb(): [number, number] | null {
  const total = detectGpu().memoryMB
  const used = smiUsedMb()
  if (used === null) return null
  return total > 0 ? [total, used] : null
}

/** 可用显存 MiB（总 − 已用）。无法判定 → null。 */
export function gpuFreeMb(): number | null {
  const mem = gpuMemMb()
  if (!mem) return null
  const [total, used] = mem
  return Math.max(0, total - used)
}

// ─── GGUF 元数据读取（只读 KV 块，不碰张量数据）──────────────────────────────

/** 严格 UTF-8 解码（Rust 的 `String::from_utf8` 对非法序列直接失败） */
const utf8Strict = new TextDecoder('utf-8', { fatal: true })

/** GGUF 元数据读取器（按文件偏移顺序读） */
class GgufReader {
  private pos = 0

  constructor(private readonly fd: number) {}

  /** 读 n 字节；不足 → null（对应 Rust `read_exact` 的 Err） */
  readBytes(n: number): Buffer | null {
    if (n === 0) return Buffer.alloc(0)
    const buf = Buffer.alloc(n)
    let got = 0
    while (got < n) {
      const r = readSync(this.fd, buf, got, n - got, this.pos + got)
      if (r <= 0) return null
      got += r
    }
    this.pos += n
    return buf
  }

  readU32(): number | null {
    const b = this.readBytes(4)
    return b ? b.readUInt32LE(0) : null
  }

  readU64(): number | null {
    const b = this.readBytes(8)
    if (!b) return null
    const v = b.readBigUInt64LE(0)
    // 超出安全整数范围的值在本模块无意义（层数/头数/长度都是小整数）
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

  /**
   * 读一个元数据值；数值型返回 `value`，其余类型（字符串/数组等）消费字节后返回 null。
   * `ok=false` 表示读取失败（Rust 的 `Option` 为 None → 整个解析失败）。
   */
  readNum(ty: number): { ok: boolean; value: number | null } {
    if (ty === 0 || ty === 1 || ty === 2 || ty === 3 || ty === 4 || ty === 5 || ty === 6 || ty === 7 || ty === 10 || ty === 11) {
      // u8/i8/u16/i16/u32/i32/f32/bool/i64/f64 —— 取整数位
      const n = ty === 0 || ty === 1 || ty === 7 ? 1 : ty === 2 || ty === 3 ? 2 : ty === 4 || ty === 5 || ty === 6 ? 4 : 8
      const raw = this.readBytes(n)
      if (!raw) return { ok: false, value: null }
      // Rust：读进 8 字节零填充缓冲再按小端解释（高位补 0）
      const padded = Buffer.alloc(8)
      raw.copy(padded, 0)
      const v = padded.readBigUInt64LE(0)
      return { ok: true, value: v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null }
    }
    if (ty === 8) {
      // string
      const s = this.readStr()
      if (s === null) return { ok: false, value: null }
      return { ok: true, value: null }
    }
    if (ty === 9 || ty === 12) {
      // array
      const elemTy = this.readU32()
      if (elemTy === null) return { ok: false, value: null }
      const len = this.readU64()
      if (len === null || len > 1 << 20) return { ok: false, value: null }
      for (let i = 0; i < len; i++) {
        const sub = this.readNum(elemTy)
        if (!sub.ok) return { ok: false, value: null }
      }
      return { ok: true, value: null }
    }
    // 未知类型 → 解析失败
    return { ok: false, value: null }
  }
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
      const num = r.readNum(ty)
      if (!num.ok) return null
      const v = num.value
      if (v === null) continue
      if (key.endsWith('.block_count')) {
        layers = v
      } else if (key.endsWith('.attention.head_count_kv')) {
        kvHeads = v
      } else if (key.endsWith('.attention.key_length')) {
        keyLen = v
      } else if (key.endsWith('.attention.value_length')) {
        valLen = v
      } else if (key.endsWith('.embedding_length')) {
        emb = v
      } else if (key.endsWith('.attention.head_count')) {
        heads = v
      }
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

/** 推理引擎注册表提供的运行时钩子（Electron 版推理注册表尚未移植 → 可为空） */
export interface VramRuntimeHooks {
  /** 某框架当前子进程 PID（精确来源） */
  enginePid?: (frameworkId: string) => number | null
  /** 某框架 active 时的估算显存（MiB；引擎已卸载自动排除） */
  activeEngineVramMb?: (frameworkId: string) => number | null
}

let runtimeHooks: VramRuntimeHooks | null = null

/** 注入推理引擎注册表钩子（注册表落地后调用；不注入则跳过这两条来源） */
export function setVramRuntimeHooks(hooks: VramRuntimeHooks | null): void {
  runtimeHooks = hooks
}

/**
 * 按进程读 GPU 显存**真值**（Windows：WMI GPU Process Memory 计数器）。
 *
 * 为什么不用 nvidia-smi：Windows/WDDM 下 `--query-compute-apps` 的 used_memory 全是 N/A
 * （本机实测 `[Insufficient Permissions], [N/A]`），旧实现因此只能回退成「模型目录大小」
 * ——把文件体积当显存，系统性少算 KV + 固定开销（本机实测差 ~1.3 GiB）。
 * WMI 计数器给的是驱动口径的 DedicatedUsage，无需管理员（本机实测与进程一一对应）。
 * 非 Windows 返回空表 → 调用方回退 nvidia-smi。
 */
export function wmiGpuProcessRows(): Array<[number, string, number]> {
  if (process.platform !== 'win32') return []
  // 一次 PowerShell 拿全部（逐行查 Win32_Process 太慢）；>50MB 才回传，行数很少
  const script = `
$procs = @{}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $procs[[int]$_.ProcessId] = $_.Name }
Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction SilentlyContinue |
  Where-Object { $_.DedicatedUsage -gt 52428800 } |
  ForEach-Object {
    $p = [int]($_.Name -replace '^pid_(\d+)_.*$', '$1')
    if ($procs.ContainsKey($p)) { '{0},{1},{2}' -f $p, $procs[$p], [int]($_.DedicatedUsage / 1MB) }
  }
`
  const out = runCommand('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
  if (!out.ok) return []
  return parseWmiRows(out.stdout)
}

/** 解析 WMI 输出行（`pid,name,MB`）——纯函数，便于单测 */
export function parseWmiRows(stdout: string): Array<[number, string, number]> {
  const rows: Array<[number, string, number]> = []
  for (const line of stdout.split(/\r?\n/)) {
    const it = line.trim().split(',')
    const pid = Number((it[0] ?? '').trim())
    const name = (it[1] ?? '').trim()
    const mb = Number((it[2] ?? '').trim())
    if (!Number.isFinite(pid) || !Number.isFinite(mb)) continue
    rows.push([pid, name, mb])
  }
  return rows
}

/**
 * 查询指定进程名的显存占用（MB）——按 PID 匹配 nvidia-smi
 * 无管理员权限时返回 null（前端显示「不可用」）
 */
export function vramOfProcess(name: string): number | null {
  // 找进程 PID
  const psCmd = `Get-Process '${name}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`
  const ps = runCommand('powershell', ['-NoProfile', '-Command', psCmd])
  if (!ps.ok) return null
  const pidRaw = ps.stdout.trim()
  if (!/^\d+$/.test(pidRaw)) return null
  const pid = Number(pidRaw)
  // nvidia-smi 按 PID 查
  const smi = runCommand('nvidia-smi', [
    '--query-compute-apps=pid,used_memory',
    '--format=csv,noheader,nounits'
  ])
  if (!smi.ok) return null
  for (const line of smi.stdout.split(/\r?\n/)) {
    const parts = line.split(',')
    const pidStr = (parts[0] ?? '').trim()
    if (!/^\d+$/.test(pidStr) || Number(pidStr) !== pid) continue
    const mbRaw = (parts[1] ?? '').trim()
    if (!/^\d+$/.test(mbRaw)) return null
    return Number(mbRaw)
  }
  return null
}

/** 显存状态（对应 Rust Tauri 命令 `get_vram_status` 的返回形状） */
export interface VramStatus {
  available: boolean
  gpu_name: string
  total_mb: number
  used_mb: number
  /** 框架 id → 占用（未加载不出现）。source：wmi=驱动真值 / smi=nvidia-smi / estimate=预估 / pid=本进程 */
  frameworks: Record<string, { mb: number; source: string }>
}

/**
 * 查询显存状态：总显存 + 已用 + 各推理框架占用（按 PID 过滤 nvidia-smi）。
 *
 * 关键：引擎已卸载 / 进程已释放时绝不能回退到"模型目录大小"估算——
 * 那会在引擎死后假报占用。只有引擎 is_loaded()（子进程活着）却查不到
 * nvidia-smi 明细（无权限）时，才用目录大小近似。
 */
export function getVramStatus(): VramStatus {
  const gpu = detectGpu()
  const totalMb = gpu.memoryMB
  // nvidia-smi 已用显存（总量，无需权限）。读不到按 0 处理（保持面板既有语义）。
  const mem = gpuMemMb()
  const usedMb = mem ? mem[1] : 0

  const rows = wmiGpuProcessRows()
  const byPid = new Map<number, number>()
  const byName = new Map<string, number>()
  for (const [pid, name, mb] of rows) {
    byPid.set(pid, mb)
    const key = name.toLowerCase()
    byName.set(key, (byName.get(key) ?? 0) + mb)
  }

  const byEngine = new Map<string, { mb: number; source: string }>()
  for (const fw of frameworkSources) {
    let hit: { mb: number; source: string } | undefined
    // 1) 本引擎的子进程（精确；残留实例不会被算进来）
    const ourPid = runtimeHooks?.enginePid?.(fw.id) ?? null
    if (ourPid !== null) {
      const mb = byPid.get(ourPid)
      if (mb !== undefined) hit = { mb, source: 'pid' }
    }
    // 2) 按进程名求和（WMI 驱动真值）
    if (!hit && fw.processName) {
      const mb = byName.get(fw.processName.toLowerCase())
      if (mb !== undefined) hit = { mb, source: 'wmi' }
    }
    // 3) nvidia-smi 按进程名查
    if (!hit && fw.processName) {
      const mb = vramOfProcess(fw.processName)
      if (mb !== null) hit = { mb, source: 'smi' }
    }
    // 4) 注册表估算（仅引擎 active 时）
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
    total_mb: totalMb,
    used_mb: usedMb,
    frameworks
  }
}
