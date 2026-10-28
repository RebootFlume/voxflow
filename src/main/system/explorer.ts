/**
 * 用系统文件管理器打开路径 —— 对齐 Rust 版 `lib.rs::rust_open_in_explorer`。
 *
 * Rust 侧手写 explorer / open / xdg-open 分支，是因为当时 Tauri 的 opener 插件
 * 既没在 builder 注册、也没申请 `opener:allow-open-path` 权限，点「打开目录」毫无反应。
 * Electron 有 `shell.openPath`，直接用它即可（并且能拿到失败原因）。
 */

import { shell } from 'electron'
import { existsSync } from 'fs'

/** 打开路径（目录 → 资源管理器；文件 → 默认程序） */
export async function openInExplorer(path: string): Promise<void> {
  if (!path) throw new Error('路径为空')
  if (!existsSync(path)) throw new Error(`路径不存在: ${path}`)
  const err = await shell.openPath(path)
  if (err) throw new Error(err)
}
