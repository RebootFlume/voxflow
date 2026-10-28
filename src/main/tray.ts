/**
 * 系统托盘 —— 对齐 Rust 版 `src-tauri/src/tray.rs`。
 *
 * 菜单：显示主窗口 / 退出。左键单击（抬起时）→ 显示并聚焦主窗口。
 */

import { Menu, Tray, type BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { trayIconPath } from './core/paths'

let tray: Tray | null = null

/** 创建托盘 */
export function createTray(getWindow: () => BrowserWindow | null, onQuit: () => void): void {
  if (tray) return

  tray = new Tray(trayIconPath())

  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow(getWindow) },
    { type: 'separator' },
    { label: '退出', click: () => onQuit() }
  ])
  tray.setContextMenu(menu)
  tray.setToolTip('VoxFlow')

  // 左键单击 → 显示并聚焦主窗口（对齐 Rust 版：show_menu_on_left_click(false)）
  tray.on('click', () => {
    showMainWindow(getWindow)
  })

  if (is.dev) {
    // 开发态右键菜单仍可用，但左键不再弹菜单
    tray.on('right-click', () => tray?.popUpContextMenu())
  }
}

/** 显示并聚焦主窗口 */
export function showMainWindow(getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** 销毁托盘 */
export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
