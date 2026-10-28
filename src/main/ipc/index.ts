/**
 * IPC 注册 —— 把主进程能力暴露给渲染进程。
 *
 * 通道：
 *  - `voxflow:invoke`  渲染进程 → 主进程：通用命令调用（命令名与 Tauri 版一致）
 *  - `voxflow:window`  渲染进程 → 主进程：窗口控制
 *  - `voxflow:dialog`  渲染进程 → 主进程：文件/目录选择
 *  - `capture:response` / `audio-devices:response`  渲染进程 → 主进程：主进程发起的请求回执
 */

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { commands } from './commands'
import { registerCaptureIpc } from '../system/capture'
import { registerAudioDevicesIpc } from '../system/audio-devices'
import type { DialogOptions, WindowAction } from '../../preload/api'

const INVOKE_CHANNEL = 'voxflow:invoke'
const WINDOW_CHANNEL = 'voxflow:window'
const DIALOG_CHANNEL = 'voxflow:dialog'

/** 注册全部 IPC 处理器 */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  // 通用命令调用
  ipcMain.handle(INVOKE_CHANNEL, async (_event, command: string, args: Record<string, unknown>) => {
    const handler = commands[command]
    if (!handler) {
      throw new Error(`未知命令: ${command}`)
    }
    return handler(args ?? {})
  })

  // 窗口控制
  ipcMain.handle(WINDOW_CHANNEL, (_event, action: WindowAction) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    switch (action) {
      case 'minimize':
        win.minimize()
        break
      case 'toggleMaximize':
        if (win.isMaximized()) win.unmaximize()
        else win.maximize()
        break
      case 'close':
        win.close()
        break
      case 'hide':
        win.hide()
        break
      case 'show':
        win.show()
        break
    }
  })

  // 文件 / 目录选择
  ipcMain.handle(DIALOG_CHANNEL, async (_event, options: DialogOptions = {}) => {
    const win = getWindow()
    const props: Electron.OpenDialogOptions = {
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
      properties:
        options.kind === 'directory'
          ? ['openDirectory', 'createDirectory']
          : options.multiple
            ? ['openFile', 'multiSelections']
            : ['openFile']
    }
    const result = win
      ? await dialog.showOpenDialog(win, props)
      : await dialog.showOpenDialog(props)

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, paths: [] }
    }
    return { canceled: false, paths: result.filePaths }
  })

  // 主进程 → 渲染进程请求的回执通道
  registerCaptureIpc()
  registerAudioDevicesIpc()
}
