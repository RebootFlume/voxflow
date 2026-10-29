/**
 * Electron 主进程入口。
 *
 * 窗口参数对齐 Tauri 版 `tauri.conf.json`：
 *   1100×720，最小 900×600，无系统边框（自定义标题栏），居中。
 *
 * 关闭行为：`closeToTray=true` 时隐藏到托盘继续运行（默认），false 时直接退出。
 */

import { app, BrowserWindow, session, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc } from './ipc'
import { getCloseToTray } from './ipc/commands'
import { isQuitting, setQuitting } from './core/app-state'
import { log } from './core/logger'
import { adoptProxyEnv } from './models/model-manager'
import { createTray, destroyTray, showMainWindow } from './tray'
import { startHotkeyListener, stopHotkeyListener } from './system/hotkey'
import { llamaEngine } from './inference/llama-server'
import { registry } from './inference/registry'

let mainWindow: BrowserWindow | null = null

/** 创建主窗口 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    center: true,
    show: false,
    // 无系统边框：前端 TitleBar 自绘（对齐 Tauri 的 decorations:false）
    frame: false,
    autoHideMenuBar: true,
    title: 'VoxFlow',
    backgroundColor: '#0b0b0f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 外部链接走系统浏览器
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 关闭行为：隐藏到托盘 or 退出
  mainWindow.on('close', (event) => {
    if (getCloseToTray() && !isQuitting()) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 开发态加载 dev server，生产态加载打包后的 html
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** 麦克风权限：录音功能依赖 getUserMedia */
function setupPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    // 只放行麦克风；其余权限一律拒绝
    callback(permission === 'media')
  })
}

app.whenReady().then(() => {
  setQuitting(false)
  electronApp.setAppUserModelId('com.voxflow.app')

  // 代理单一来源：配置为空则接管环境变量（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY）。
  // Rust 版靠 reqwest 隐式读 env，Node 的 fetch 不会 —— 所以这里显式接管，
  // 让「用户只在系统里配了代理」的场景与 Tauri 版行为一致。
  const effectiveProxy = adoptProxyEnv()
  log.info(`[proxy] 生效代理: ${effectiveProxy === '' ? '(直连)' : effectiveProxy}`)

  // 开发态按 F12 打开 DevTools；生产态忽略 CommandOrControl+R
  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  setupPermissions()
  registerIpc(() => mainWindow)
  createWindow()
  createTray(
    () => mainWindow,
    () => {
      setQuitting(true)
      app.quit()
    }
  )

  // 全局热键监听（uIOhook；不可用时仅该功能降级）
  startHotkeyListener()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showMainWindow(() => mainWindow)
  })
})

// 窗口全部关闭后：macOS 保留进程，其它平台退出（与 Tauri 版一致）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 退出前清理：停热键监听 + 停推理引擎子进程
app.on('before-quit', () => {
  setQuitting(true)
  stopHotkeyListener()
  llamaEngine.killForExit()
  void registry().unloadActive().catch(() => {})
  destroyTray()
})
