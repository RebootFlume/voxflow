/**
 * 归档解压（异步）。
 *
 * ## 为什么要独立成异步模块
 * Rust 版用 `std::process::Command`（同步）解压，代价是**整个解压过程占住主线程**。
 * 移植到 Electron 后这个代价比 Tauri 严重得多：Electron 主线程一卡，
 * 渲染进程收不到 IPC 响应，窗口直接变成「未响应」，Windows 会判定 AppHang
 * （实测：解一个 800MB 的运行时包足以让用户以为程序崩了）。
 *
 * 因此这里全部改成 `spawn` + Promise，**解压期间主进程事件循环照常运转**。
 *
 * 关键点：
 * - tar.bz2 / tar.gz 是「压缩层 + tar 层」两层：bsdtar 一次处理两层；
 *   7-Zip 只解掉压缩层、吐出内层 .tar ⇒ 需要递归展开（最多 3 层，防恶意包）
 * - 优先用 bsdtar（Windows 自带 `System32\tar.exe`，支持 zip 与 tar.*）
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** 7-Zip 常见安装位置 */
const SEVEN_ZIP_CANDIDATES = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  'D:\\app\\7-Zip\\7z.exe'
]

/** 跑一条外部命令并等它结束（不阻塞事件循环） */
function runCommand(exe: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' })
    child.on('error', (e) => reject(new Error(`${exe} 启动失败: ${e.message}`)))
    child.on('close', (code) => resolve(code ?? -1))
  })
}

/** bsdtar 路径（Windows 自带；全路径避免 GNU tar 把 D: 当远程主机） */
function bsdtarPath(): string {
  return process.platform === 'win32'
    ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
}

/** 用 bsdtar 解压（zip / tar.bz2 / tar.gz 通吃） */
async function extractWithBsdtar(pkgPath: string, dest: string): Promise<void> {
  const exe = bsdtarPath()
  if (process.platform === 'win32' && !existsSync(exe)) {
    throw new Error('bsdtar 不存在')
  }
  const code = await runCommand(exe, ['-xf', pkgPath, '-C', dest])
  if (code !== 0) throw new Error(`bsdtar 失败（退出码: ${code}）`)
}

/** 用 7-Zip 解压 */
async function extractWith7z(pkgPath: string, dest: string): Promise<void> {
  for (const exe of SEVEN_ZIP_CANDIDATES) {
    if (!existsSync(exe)) continue
    const code = await runCommand(exe, ['x', pkgPath, '-y', `-o${dest}`])
    if (code === 0) return
  }
  throw new Error('7-Zip 不可用或失败')
}

/**
 * 解压归档（zip / tar.bz2 / tar.gz 通用）。
 *
 * 递归展开内层 .tar：7-Zip 只解出内层 .tar 时，把它也解开并删除（最多 3 层）。
 */
export async function extractArchiveAsync(pkgPath: string, dest: string): Promise<void> {
  const name = pkgPath.toLowerCase()
  const isTwoLayer =
    name.endsWith('.tar.bz2') || name.endsWith('.tar.gz') || name.endsWith('.tgz')

  // 先按类型选优解压器
  if (isTwoLayer) {
    try {
      await extractWithBsdtar(pkgPath, dest)
    } catch {
      await extractWith7z(pkgPath, dest)
    }
  } else {
    try {
      await extractWith7z(pkgPath, dest)
    } catch {
      await extractWithBsdtar(pkgPath, dest)
    }
  }

  // 递归展开内层 tar 包
  for (let i = 0; i < 3; i++) {
    let inner: string | null = null
    try {
      for (const e of readdirSync(dest, { withFileTypes: true })) {
        const f = e.name.toLowerCase()
        if (f.endsWith('.tar') || f.endsWith('.tar.bz2') || f.endsWith('.tar.gz')) {
          inner = join(dest, e.name)
          break
        }
      }
    } catch {
      break
    }
    if (!inner) break
    const t = inner.toLowerCase()
    if (t.endsWith('.tar.bz2') || t.endsWith('.tar.gz') || t.endsWith('.tgz')) {
      await extractWithBsdtar(inner, dest).catch(() => undefined)
    } else {
      await extractWith7z(inner, dest).catch(() => undefined)
    }
    rmSync(inner, { force: true })
  }
}
