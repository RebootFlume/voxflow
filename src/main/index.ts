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
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc } from './ipc'
import { getCloseToTray } from './ipc/commands'
import { isQuitting, setQuitting } from './core/app-state'
import { log } from './core/logger'
import { defaultModelRoot, readSavedModelRoot } from './core/data-root'
import { appIconPath } from './core/paths'
import { ensureSingleInstance } from './core/single-instance'
import { adoptProxyEnv, setModelRoot } from './models/model-manager'
import { createTray, destroyTray, showMainWindow } from './tray'
import { startHotkeyListener, stopHotkeyListener } from './system/hotkey'
import { llamaEngine } from './inference/llama-ffi'
import { sherpaFfiAdapter } from './inference/sherpa-ffi'
import { registry } from './inference/registry'
import { setVramRuntimeHooks } from './inference/vram'
import { killOrphanEngineProcesses } from './inference/device'
import { migrateLegacyAudiocppRuntime } from './inference/runtime-download'
import { ttsRegistry } from './tts/registry'

let mainWindow: BrowserWindow | null = null

/** 单实例控制通道（主实例持有；退出时关闭） */
let instanceHandle: { isPrimary: boolean; status: string; close: () => void } | null = null

/** 第二个实例请求唤起窗口时，主窗口可能还没建好 → 先记着，建好后再显示 */
let pendingShow = false

/** 唤起主窗口（窗口还没就绪时先记账） */
function revealMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow(() => mainWindow)
  } else {
    pendingShow = true
  }
}

/** 本次会话当前持有的引擎子进程 PID（孤儿清理时不能杀） */
function currentEnginePids(): Set<number> {
  const pids = new Set<number>()
  for (const fw of ['llama.cpp', 'sherpa-onnx']) {
    const pid = registry().engine(fw)?.pid()
    if (pid) pids.add(pid)
  }
  return pids
}

/** 创建主窗口 */
function createWindow(): void {
  // 开发态必须显式给窗口图标：否则任务栏/Alt+Tab 显示的是 electron.exe 自带的
  // Electron 官方图标（迁移后用户看到的"还是 Electron 默认图标"就是它）。
  // 打包态 exe 图标来自 electron-builder（build/icon.ico），这里同样指向应用图标。
  const icon = appIconPath()
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    center: true,
    show: false,
    icon: existsSync(icon) ? icon : undefined,
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
    // 启动期间有第二个实例来唤起过窗口 → 这里补一次聚焦
    if (pendingShow) {
      pendingShow = false
      mainWindow?.focus()
    }
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

app.whenReady().then(async () => {
  setQuitting(false)
  electronApp.setAppUserModelId('com.voxflow.app')

  // 全局单实例：第二个实例只负责唤起主窗口，然后自己退出。
  // 必须放在建窗口 / 起引擎之前 —— 否则两个实例会互相抢端口（端口守卫会把
  // 对方正在用的引擎当成"自己的残留"杀掉）、抢全局热键、抢配置文件。
  instanceHandle = await ensureSingleInstance({ onShow: revealMainWindow })
  if (!instanceHandle.isPrimary) {
    app.exit(0)
    return
  }

  // 代理单一来源：配置为空则接管环境变量（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY）。
  // Rust 版靠 reqwest 隐式读 env，Node 的 fetch 不会 —— 所以这里显式接管，
  // 让「用户只在系统里配了代理」的场景与 Tauri 版行为一致。
  const effectiveProxy = adoptProxyEnv()
  log.info(`[proxy] 生效代理: ${effectiveProxy === '' ? '(直连)' : effectiveProxy}`)

  // 恢复已保存的模型根（对齐 Rust 版 setup()：从 config.json 读 models.modelRoot）。
  // 不恢复的话主进程会一直用默认的「数据根/models」，而前端展示的是用户另存的目录
  // → 清单、下载、加载全都对不上。
  const savedModelRoot = readSavedModelRoot() ?? defaultModelRoot()
  try {
    const resolved = setModelRoot(savedModelRoot)
    log.info(`[model] 模型根: ${resolved}`)
  } catch (e) {
    log.warn(`[model] 恢复模型根失败（改用默认）: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 旧版 audio.cpp 是 cpu / cuda 两个运行时包，现在合并成一个全功能包：
  // 把旧的 libs/audio-cpp-cuda 并进 libs/audio-cpp，已装用户不必重下 2GB。
  try {
    const moved = migrateLegacyAudiocppRuntime()
    if (moved.length > 0) log.info(`[framework] audio.cpp 旧变体目录已合并: ${moved.join('、')}`)
  } catch (e) {
    log.warn(`[framework] audio.cpp 旧变体目录迁移失败: ${String(e)}`)
  }

  // 开发态按 F12 打开 DevTools；生产态忽略 CommandOrControl+R
  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  setupPermissions()
  registerIpc(() => mainWindow)

  // 显存监控钩子：让 vram 模块知道「哪些框架此刻真有引擎在跑」。
  // 没有它，vram 只能每轮都盲查 WMI（3.3s PowerShell）；有了它，空闲时一个外部命令都不起。
  // 这也顺带激活「按本进程 PID 取真值」这条精确来源（残留实例不会被算成我们的占用）。
  setVramRuntimeHooks({
    enginePid: (frameworkId) => registry().engine(frameworkId)?.pid() ?? null,
    engineVramMb: (frameworkId) => {
      // 引擎自报（进程内 FFI 引擎读设备显存差值）= 真值；拿不到再回退估算
      const asr = registry().engine(frameworkId)
      if (!asr || !asr.isLoaded()) return null
      return asr.vramSelfReportedMb?.() ?? null
    },
    activeEngineVramMb: (frameworkId) => {
      const asr = registry().engine(frameworkId)
      const asrMb = asr && asr.isLoaded() ? asr.vramEstimateMb() : null
      if (asrMb != null) return asrMb
      return ttsRegistry().activeFrameworkName() === frameworkId ? ttsRegistry().vramMb() : null
    },
    anyActive: () => registry().activeEngine() !== undefined || ttsRegistry().isLoaded()
  })

  createWindow()
  // 注：单实例判定结果不在这里记日志 —— 主进程日志走 sidecar 事件，
  // 渲染进程就绪前发出的事件会丢。改在渲染进程启动时发的第一条 bootstrap 消息里记
  // （见 ipc/commands.ts 的 bootstrap 分支）。
  createTray(
    () => mainWindow,
    () => {
      setQuitting(true)
      app.quit()
    }
  )

  // 启动清理：崩溃 / 被强杀留下的引擎孤儿（占端口、吃显存）。
  // 后台异步做，不挡窗口显示。判定只看**可执行文件路径是否在本软件 libs 下**
  // （和端口守卫同一套规则），本次会话自己起的引擎会被排除。
  void killOrphanEngineProcesses(currentEnginePids).catch((e) => {
    log.warn(`[orphan-clean] 清理失败: ${e instanceof Error ? e.message : String(e)}`)
  })

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
  // 退出路径只终止子进程、不等它退出（对齐 Rust 的 kill_for_exit：
  // 等进程退出会让「点了关闭要等好几秒托盘图标才消失」）
  llamaEngine.killForExit()
  sherpaFfiAdapter.killForExit()
  // 合成中的 sherpa-tts 子进程同理（每次合成起一个，之前完全没跟踪）
  ttsRegistry().killForExit?.()
  void registry().unloadActive().catch(() => {})
  destroyTray()
  instanceHandle?.close()
})
