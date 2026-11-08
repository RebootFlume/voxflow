/**
 * 共享基础设施：推理设备枚举 + 引擎子进程监督（端口守卫）
 *
 * 对齐 Rust 版 `src-tauri/src/inference/device.rs`：
 * 从 `inference/engine.rs` 与 `inference/llama_server.rs` 抽出，
 * 供所有引擎（llama.cpp FFI worker / sherpa）共用。
 *
 * 依赖说明：进程相关操作全部走 Win32 FFI（`core/win32/process-table`）
 * + Node 内置 `process.kill`，**不依赖 PowerShell / netstat / taskkill**。
 */

import { createServer, Socket } from 'node:net'
import { log } from '../core/logger'
import { listProcesses, type ProcessEntry } from '../core/win32/process-table'
import { libsDir } from './runtime-paths'

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
export function isOurEngineExe(exe: string): boolean {
  const libs = libsDir()
  return normPath(exe).startsWith(normPath(libs))
}

/** 引擎进程筛选条件 */
export interface EngineProcessFilter {
  /**
   * 只保留这些**可执行文件名**（大小写不敏感）。
   * 不传 = 本软件 libs 目录下的全部引擎进程。
   *
   * 用文件名而不是全路径：调用方知道引擎 exe 的名字，但不知道它被装在哪一版运行库里。
   */
  exeNames?: string[]
}

/**
 * 列出本软件 libs 目录下的引擎进程。
 *
 * 判定 = **可执行文件路径归属**（在本软件 libs 目录下），不是进程名 ——
 * 用户自己装的同名引擎绝不能被误杀。
 */
export function listOurEngineProcesses(filter: EngineProcessFilter = {}): ProcessEntry[] {
  const wanted = filter.exeNames?.map((n) => n.toLowerCase())
  return listProcesses().filter((p) => {
    if (!isOurEngineExe(p.exePath)) return false
    if (!wanted || wanted.length === 0) return true
    const base = p.exePath.replace(/^.*[\\/]/, '').toLowerCase()
    return wanted.includes(base)
  })
}

/**
 * 杀掉指定 PID（Node 内置 `process.kill`；Windows 下等价于 TerminateProcess）。
 *
 * @returns 实际发出终止信号的 PID 列表（进程可能已经自己退了）
 */
export function killPids(pids: number[]): number[] {
  const killed: number[] = []
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
      killed.push(pid)
    } catch {
      // 进程可能已经自己退了 —— 忽略
    }
  }
  return killed
}

/**
 * 清理「本软件 libs 目录下的引擎残留进程」（崩溃 / 被强杀留下的孤儿）。
 *
 * 为什么需要：用户强杀应用时，子进程（llama.cpp / sherpa-onnx FFI worker）
 * 会变成孤儿继续占着端口和显存；下次启动时一次性把不属于本次会话的引擎清掉。
 *
 * 实现：Win32 FFI 进程表（~10ms，无外部命令）→ 按路径归属筛选 → Node 内置终止。
 * 旧实现是 PowerShell 全量 `Get-Process`（冷启动 1~3s，启动期最贵的一笔）。
 *
 * @param exclude 需要跳过的 PID（本次会话自己起的引擎）。传函数是为了**杀之前**再取一次，
 *               避免扫描快照之后我们新起的引擎被误杀。
 * @returns 被杀掉的 PID 列表
 */
export async function killOrphanEngineProcesses(
  exclude: () => Set<number> = () => new Set()
): Promise<number[]> {
  if (process.platform !== 'win32') return []

  const candidates = listOurEngineProcesses()
    .map((p) => p.pid)
    .filter((pid) => pid !== process.pid)

  const killed: number[] = []
  for (const pid of candidates) {
    // 杀之前再取一次排除集：扫描快照之后我们可能刚起了新引擎
    if (exclude().has(pid)) continue
    if (killPids([pid]).length > 0) {
      killed.push(pid)
      log.warn(`[orphan-clean] 清理残留引擎 PID=${pid}`)
    }
  }
  if (killed.length > 0) {
    log.warn(`[orphan-clean] 共清理 ${killed.length} 个残留引擎进程`)
  }
  return killed
}

/**
 * 定向清理本软件引擎（按可执行文件名）。
 *
 * 用途：某类引擎要重新启动前，先把"上一会话残留的同款引擎"清掉
 * （它们会占着固定端口，造成"端口通 = 假就绪"）。
 * 只清**本软件 libs 下、同名**的进程，外部引擎（路径不在本软件目录）一律不碰。
 *
 * @returns 被杀掉的 PID 列表
 */
export async function killOurEngineProcesses(filter: EngineProcessFilter): Promise<number[]> {
  if (process.platform !== 'win32') return []

  const candidates = listOurEngineProcesses(filter)
    .map((p) => p.pid)
    .filter((pid) => pid !== process.pid)

  const killed = killPids(candidates)
  if (killed.length > 0) {
    log.warn(`[engine-clean] 清理本软件引擎进程 ${killed.join(', ')}`)
  }
  return killed
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
