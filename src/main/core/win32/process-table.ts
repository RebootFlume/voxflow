/**
 * Windows 进程表：一次拿到「PID → 可执行文件完整路径」。
 *
 * 为什么不用 PowerShell：`Get-Process` 全量扫描冷启动 1~3s（启动期最贵的一笔），
 * 而且依赖 Windows 命令行工具（PowerShell）。这里直接 FFI 调 psapi/kernel32，
 * 实测 147 个进程约 10ms，且不依赖任何外部命令。
 *
 * 平台限定：仅 Windows。其它平台或 DLL 加载失败时返回空表，
 * 调用方按"查不到"处理（宁可不杀，也不误杀）。
 */

import koffi from 'koffi'

/** 进程条目（PID + 可执行文件完整路径） */
export interface ProcessEntry {
  pid: number
  exePath: string
}

/** Win32 需要的最小 API 面（只声明用到的四个函数） */
interface Win32ProcessApi {
  enumProcesses: (pids: Uint32Array, bytes: number, needed: Uint32Array) => number
  openProcess: (access: number, inherit: number, pid: number) => bigint
  queryImageName: (handle: bigint, flags: number, buf: Buffer, size: Uint32Array) => number
  closeHandle: (handle: bigint) => number
}

/** PROCESS_QUERY_LIMITED_INFORMATION：只读查询进程路径所需的最小权限 */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
/** 一次枚举的 PID 上限（Windows 上限约 32768，取 8192 足够覆盖常见场景） */
const ENUM_CAPACITY = 8192
/** 路径缓冲（UTF-16，1024 字节 = 512 字符，足够放 exe 路径） */
const PATH_BUFFER_BYTES = 1024

let api: Win32ProcessApi | null | undefined

/** 懒加载 Win32 绑定（失败则永久降级为空表） */
function win32Api(): Win32ProcessApi | null {
  if (api !== undefined) return api
  api = null
  if (process.platform !== 'win32') return api
  try {
    const load = (name: string): ReturnType<typeof koffi.load> => {
      try {
        return koffi.load(name)
      } catch {
        // 某些环境解析不到裸名（PATH 未含 System32）→ 用绝对路径
        return koffi.load(`C:/Windows/System32/${name}`)
      }
    }
    const psapi = load('psapi.dll')
    const kernel32 = load('kernel32.dll')
    api = {
      enumProcesses: psapi.func('EnumProcesses', 'uint32', [
        'void *',
        'uint32',
        'void *'
      ]) as unknown as Win32ProcessApi['enumProcesses'],
      openProcess: kernel32.func('OpenProcess', 'void *', [
        'uint32',
        'int32',
        'uint32'
      ]) as unknown as Win32ProcessApi['openProcess'],
      queryImageName: kernel32.func('QueryFullProcessImageNameW', 'int32', [
        'void *',
        'uint32',
        'void *',
        'void *'
      ]) as unknown as Win32ProcessApi['queryImageName'],
      closeHandle: kernel32.func('CloseHandle', 'int32', ['void *']) as unknown as Win32ProcessApi[
        'closeHandle'
      ]
    }
  } catch {
    api = null
  }
  return api
}

/**
 * 列出当前所有能读到路径的进程。
 *
 * 无权限读取路径的进程（系统进程）会被跳过 —— 我们只关心"路径归属"，
 * 读不到路径的进程一律按"不是我们的引擎"处理。
 */
export function listProcesses(): ProcessEntry[] {
  const a = win32Api()
  if (!a) return []

  const pids = new Uint32Array(ENUM_CAPACITY)
  const needed = new Uint32Array(1)
  a.enumProcesses(pids, pids.byteLength, needed)
  const count = Math.min(Math.floor(needed[0] / 4), ENUM_CAPACITY)

  const out: ProcessEntry[] = []
  const buf = Buffer.alloc(PATH_BUFFER_BYTES)
  const sizePtr = new Uint32Array(1)
  for (let i = 0; i < count; i++) {
    const pid = pids[i]
    if (!pid) continue
    const handle = a.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
    if (!handle) continue
    try {
      sizePtr[0] = PATH_BUFFER_BYTES / 2
      if (a.queryImageName(handle, 0, buf, sizePtr)) {
        out.push({ pid, exePath: buf.toString('ucs2', 0, sizePtr[0]).replace(/\0+$/, '') })
      }
    } finally {
      a.closeHandle(handle)
    }
  }
  return out
}
