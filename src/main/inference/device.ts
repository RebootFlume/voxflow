/**
 * 共享基础设施：推理设备枚举 + 引擎子进程监督（端口守卫）
 *
 * 对齐 Rust 版 `src-tauri/src/inference/device.rs`：
 * 从 `inference/engine.rs` 与 `inference/llama_server.rs` 抽出，
 * 供所有引擎（llama.cpp FFI worker / sherpa / pytorch）共用。
 */

import { execFile } from 'node:child_process'
import { createServer, Socket } from 'node:net'
import { promisify } from 'node:util'
import { log } from '../core/logger'
import { libsDir } from './runtime-paths'

const execFileAsync = promisify(execFile)

/** 推理设备 */
export type Device =
  | { kind: 'cpu' }
  | { kind: 'cuda'; index: number } // GPU 设备 ID
  | { kind: 'metal' } // Apple Silicon
  | { kind: 'directml' } // Windows DirectML

/** 设备名 → 设备枚举（未知名字一律退回 CPU） */
export function deviceFromString(s: string): Device {
  switch (s.toLowerCase()) {
    case 'cuda':
    case 'gpu':
      return { kind: 'cuda', index: 0 }
    case 'metal':
    case 'mps':
      return { kind: 'metal' }
    case 'directml':
    case 'dml':
      return { kind: 'directml' }
    default:
      return { kind: 'cpu' }
  }
}

/** 设备枚举 → 设备名 */
export function deviceToString(d: Device): string {
  switch (d.kind) {
    case 'cpu':
      return 'cpu'
    case 'cuda':
      return 'cuda'
    case 'metal':
      return 'metal'
    case 'directml':
      return 'directml'
    default:
      return 'cpu'
  }
}

/** 路径规范化（比较用）：Windows 大小写不敏感 + 分隔符归一 */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/**
 * 该进程是否由本软件自己的 runtime（exe 旁 libs/）启动。
 * 只清理"自己的引擎进程"（本实例启动或本软件历史会话残留），
 * 绝不杀用户/第三方自装的引擎 —— 即使它恰好监听同一端口。
 */
function isOurEngineExe(exe: string): boolean {
  const libs = libsDir()
  return normPath(exe).startsWith(normPath(libs))
}

/** 取进程可执行文件路径（PowerShell；仅 Windows 有效） */
async function processExePath(pid: number): Promise<string | null> {
  let stdout: string
  try {
    const out = await execFileAsync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`],
      { windowsHide: true, maxBuffer: 1024 * 1024 }
    )
    stdout = out.stdout
  } catch {
    return null
  }
  const s = stdout.trim()
  if (s === '') return null
  return s
}

/**
 * **批量**取多个 PID 的可执行文件路径（一次 PowerShell 调用）。
 *
 * 为什么要批量：之前是"每个 PID 起一次 PowerShell"（冷启动 ~0.3~0.5s/次），
 * 端口上常有 1~2 个 PID，串起来就是 1 秒左右的等待 —— 每次加载模型都要付一次。
 * 合成一次调用后只剩一次冷启动（实测 Get-Process 批量查 2 个 PID ≈ 210ms，
 * 其中绝大部分就是 PowerShell 冷启动）。
 *
 * 输出格式：`PID|路径`，用单引号 + `-f` 格式化，避免命令里出现双引号
 * （Node 传参 + PowerShell 二次解析时双引号最容易被吃掉）。
 */
export async function processExePaths(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (pids.length === 0) return out
  if (process.platform !== 'win32') return out

  const idList = pids.join(',')
  try {
    const r = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-Process -Id ${idList} -ErrorAction SilentlyContinue | ForEach-Object { '{0}|{1}' -f $_.Id, $_.Path }`
      ],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    )
    for (const line of r.stdout.split(/\r?\n/)) {
      const t = line.trim()
      if (t === '') continue
      const idx = t.indexOf('|')
      if (idx <= 0) continue
      const pid = Number.parseInt(t.slice(0, idx), 10)
      const path = t.slice(idx + 1).trim()
      if (Number.isFinite(pid) && path !== '') out.set(pid, path)
    }
    return out
  } catch {
    // 批量查询失败 → 退回逐个查询（慢，但不会漏判）
  }

  for (const pid of pids) {
    const p = await processExePath(pid)
    if (p) out.set(pid, p)
  }
  return out
}

/**
 * 清理「本软件 libs 目录下的引擎残留进程」（崩溃 / 被强杀留下的孤儿）。
 *
 * 为什么需要：用户强杀应用时，子进程（sherpa / python worker）
 * 会变成孤儿继续占着端口和显存；下次启动时端口守卫要一个个查路径再杀，
 * 慢且容易留下"端口通 = 假就绪"的怪状态。这里在启动后扫一遍，
 * 一次性把不属于本次会话的引擎清掉。
 *
 * 判定规则与端口守卫一致：**按可执行文件路径归属**（在本软件 libs 目录下），
 * 不是按进程名 —— 用户自己装的同名引擎绝不能被误杀。
 *
 * @param exclude 需要跳过的 PID（本次会话自己起的引擎）。传函数是为了**杀之前**再取一次，
 *               避免扫描快照之后我们新起的引擎被误杀。
 * @returns 被杀掉的 PID 列表
 */
export async function killOrphanEngineProcesses(
  exclude: () => Set<number> = () => new Set()
): Promise<number[]> {
  if (process.platform !== 'win32') return []

  let stdout: string
  try {
    const r = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-Process -ErrorAction SilentlyContinue | ForEach-Object { try { '{0}|{1}' -f $_.Id, $_.Path } catch { } }"
      ],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    )
    stdout = r.stdout
  } catch (e) {
    log.warn(`[orphan-clean] 进程清单查询失败: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }

  const candidates: number[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim()
    if (t === '') continue
    const idx = t.indexOf('|')
    if (idx <= 0) continue
    const pid = Number.parseInt(t.slice(0, idx), 10)
    const path = t.slice(idx + 1).trim()
    if (!Number.isFinite(pid) || path === '') continue
    if (pid === process.pid) continue
    if (!isOurEngineExe(path)) continue
    candidates.push(pid)
  }

  const killed: number[] = []
  for (const pid of candidates) {
    // 杀之前再取一次排除集：扫描快照之后我们可能刚起了新引擎
    if (exclude().has(pid)) continue
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true })
      killed.push(pid)
      log.warn(`[orphan-clean] 清理残留引擎 PID=${pid}`)
    } catch {
      // 进程可能已经自己退了 —— 忽略
    }
  }
  if (killed.length > 0) {
    log.warn(`[orphan-clean] 共清理 ${killed.length} 个残留引擎进程`)
  }
  return killed
}

/**
 * 杀掉占用指定端口的「本软件引擎」进程（仅 Windows）。
 * 判定依据 = 进程可执行文件是否在本软件 libs 目录下（路径归属），不是图像名：
 * - 自己的引擎 / 历史会话残留 → 杀掉（防止死进程占着固定端口造成"端口通=假就绪"）
 * - 用户或第三方自装的引擎（路径不在本软件目录）→ 不杀
 * - 无法读取路径的进程 → 保守不杀（宁可让后续走"端口被占"逻辑，也不误伤）
 */
export async function killPortOwner(port: number): Promise<void> {
  if (process.platform !== 'win32') return

  let stdout: string
  try {
    const out = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    stdout = out.stdout
  } catch {
    return
  }

  const text = stdout
  const needle = `:${port}`
  const pids: number[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(needle) || !line.includes('LISTENING')) continue
    const parts = line.trim().split(/\s+/)
    const pid = Number.parseInt(parts[parts.length - 1] ?? '', 10)
    if (Number.isFinite(pid) && !pids.includes(pid)) pids.push(pid)
  }

  // 一次性查出所有占用进程的路径（一次 PowerShell 调用，而不是每个 PID 一次）
  const exeMap = await processExePaths(pids)

  for (const pid of pids) {
    const exe = exeMap.get(pid)
    if (!exe) {
      log.warn(`[port-guard] 端口 ${port} 的 PID=${pid} 无法确认路径，保守跳过（不误杀）`)
      continue
    }
    if (!isOurEngineExe(exe)) {
      log.warn(
        `[port-guard] 端口 ${port} 被外部进程占用（${exe}，非本软件引擎），不杀 —— 需要走换端口/报错逻辑`
      )
      continue
    }
    log.warn(`[port-guard] 清理本软件残留引擎 PID=${pid}（${exe}）`)
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true })
    } catch {
      // 进程可能已经自己退了 —— 忽略
    }
  }
}

/**
 * 连接探测的超时：无人监听时 `connect` 可能等 SYN 重传超时（本机实测 ≈2s，
 * 被安全软件拦 SYN 的机器更久），所以任何"探活"都必须带超时。
 * 与 `llama_server` 深度诊断用的 500ms 保持一致。
 */
export const PROBE_TIMEOUT = 500

/** 端口是否有服务在监听（**带超时**的 connect 探测；探活语义） */
export function portServing(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket()
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, '127.0.0.1')
  })
}

/**
 * 端口是否可被独占绑定（**瞬时**：被占用会立刻返回 AddrInUse）
 *
 * 这才是"端口已释放"的正确判定：原实现用 connect 探测，遇到"仍被绑定未监听 /
 * TIME_WAIT"的端口会误判为已释放（connect 连不上），而我们要问的正是
 * "新进程现在能不能 bind"。
 */
export function portBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      try {
        server.close(() => resolve(ok))
      } catch {
        resolve(ok)
      }
    }
    server.once('error', () => finish(false))
    server.listen(port, '127.0.0.1', () => finish(true))
  })
}

/** 从 start 起找第一个可绑定端口（bind 探测，瞬时） */
export async function findFreePort(start: number): Promise<number | null> {
  for (let p = start; p < start + 200; p++) {
    if (await portBindable(p)) return p
  }
  return null
}

/** 等待端口可被绑定（旧进程刚杀后，避免新进程 bind 冲突） */
export async function waitPortClosed(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portBindable(port)) return
    await delay(100)
  }
  log.warn(`[port-guard] 等待端口 ${port} 释放超时`)
}

/** 睡眠（毫秒） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
