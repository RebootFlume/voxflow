/**
 * 预加载脚本：在隔离上下文中把主进程能力安全地暴露给渲染进程。
 *
 * 设计目标：渲染进程侧保持 Tauri 版的调用形状（`invoke` / `listen`），
 * 这样前端除桥接文件外几乎不需要改动 —— 与 Tauri 版 `src/lib/tauri.ts` 的角色一致。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DialogOptions, DialogResult, VoxFlowAPI, WindowAction } from './api'

/** 渲染进程 → 主进程：通用命令调用（对应 Tauri 的 `invoke`） */
const INVOKE_CHANNEL = 'voxflow:invoke'
/** 主进程 → 渲染进程：sidecar 事件总线（对应 Tauri 的 `sidecar://event`） */
const SIDECAR_EVENT_CHANNEL = 'voxflow:sidecar-event'
/** 主进程 → 渲染进程：ASR 录音状态（对应 Tauri 的 `asr://status`） */
const ASR_STATUS_CHANNEL = 'voxflow:asr-status'
/** 渲染进程 → 主进程：窗口控制 */
const WINDOW_CHANNEL = 'voxflow:window'
/** 渲染进程 → 主进程：文件/目录选择 */
const DIALOG_CHANNEL = 'voxflow:dialog'

/** 采集 / 音频设备：主进程向渲染进程发请求，渲染进程用 invoke 回执 */
const CAPTURE_COMMAND_CHANNEL = 'capture:command'
const CAPTURE_RESPONSE_CHANNEL = 'capture:response'
const AUDIO_DEVICES_COMMAND_CHANNEL = 'audio-devices:command'
const AUDIO_DEVICES_RESPONSE_CHANNEL = 'audio-devices:response'

/** 实际注册到 ipcRenderer 上的监听函数签名 */
type IpcListener = (e: IpcRendererEvent, ...args: unknown[]) => void

/**
 * 原始 handler → 实际注册到 ipcRenderer 的包装函数。
 *
 * 为什么需要这张表：ipcRenderer.on() 注册的是**包装函数**（把 Electron 的
 * `(event, ...args)` 适配成 Tauri 风格的 `(payload)`），而 ipcRenderer.removeListener()
 * 按**函数引用**匹配 —— 拿原始 handler 去 remove 永远匹配不上，
 * 退订会静默失效、监听器持续累积（前端 `useSidecarEvents.ts` 的 cleanup 依赖退订）。
 * 所以必须把「注册时用的那个包装函数引用」原样存下来，退订时用它来摘。
 */
const listenerWrappers = new WeakMap<object, Map<string, IpcListener>>()

/**
 * 多订阅通道（sidecar://event、asr://status）：同一通道允许有多个订阅者，
 * 每次注册返回的退订函数只会摘掉自己那一个。
 */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const wrapper: IpcListener = (_e, ...args) => handler(args[0] as T)
  let byChannel = listenerWrappers.get(handler)
  if (!byChannel) {
    byChannel = new Map<string, IpcListener>()
    listenerWrappers.set(handler, byChannel)
  }
  byChannel.set(channel, wrapper)
  ipcRenderer.on(channel, wrapper)
  return () => {
    // 必须用同一个 wrapper 引用摘除，否则 removeListener 匹配不上
    ipcRenderer.removeListener(channel, wrapper)
    byChannel?.delete(channel)
  }
}

/**
 * 单订阅通道（capture:command / audio-devices:command）：
 * 主进程 → 渲染进程的一问一答指令通道，渲染进程侧只应有一个处理器。
 * 重复注册（模块热重载、bridge 被再次初始化）时先摘掉旧的，
 * 避免同一条指令被处理/响应两次（主进程按 requestId 配对，重复响应会串号）。
 */
const singleListeners = new Map<string, IpcListener>()

function subscribeSingle<T>(channel: string, handler: (payload: T) => void): void {
  const prev = singleListeners.get(channel)
  if (prev) {
    ipcRenderer.removeListener(channel, prev)
    singleListeners.delete(channel)
  }
  const wrapper: IpcListener = (_e, ...args) => handler(args[0] as T)
  singleListeners.set(channel, wrapper)
  ipcRenderer.on(channel, wrapper)
}

const api: VoxFlowAPI = {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
    return ipcRenderer.invoke(INVOKE_CHANNEL, command, args ?? {}) as Promise<T>
  },

  listen<T = unknown>(
    event: 'sidecar://event' | 'asr://status',
    handler: (payload: T) => void
  ): Promise<() => void> {
    const channel = event === 'asr://status' ? ASR_STATUS_CHANNEL : SIDECAR_EVENT_CHANNEL
    // Electron 的 on 是同步的；用 Promise 包装以匹配 Tauri `listen` 的异步签名
    return Promise.resolve(subscribe(channel, handler))
  },

  async openDialog(options: DialogOptions = {}): Promise<DialogResult> {
    return ipcRenderer.invoke(DIALOG_CHANNEL, options) as Promise<DialogResult>
  },

  window: {
    minimize: () => ipcRenderer.invoke(WINDOW_CHANNEL, 'minimize' as WindowAction),
    toggleMaximize: () => ipcRenderer.invoke(WINDOW_CHANNEL, 'toggleMaximize' as WindowAction),
    close: () => ipcRenderer.invoke(WINDOW_CHANNEL, 'close' as WindowAction),
    hide: () => ipcRenderer.invoke(WINDOW_CHANNEL, 'hide' as WindowAction),
    show: () => ipcRenderer.invoke(WINDOW_CHANNEL, 'show' as WindowAction)
  },

  capture: {
    onCommand: (handler) => {
      subscribeSingle(CAPTURE_COMMAND_CHANNEL, handler)
    },
    respond: (requestId: number, ok: boolean, payload?: unknown, error?: string) =>
      ipcRenderer.invoke(CAPTURE_RESPONSE_CHANNEL, { requestId, ok, payload, error }) as Promise<void>
  },

  audioDevices: {
    onCommand: (handler) => {
      subscribeSingle(AUDIO_DEVICES_COMMAND_CHANNEL, handler)
    },
    respond: (requestId: number, ok: boolean, payload?: unknown, error?: string) =>
      ipcRenderer.invoke(AUDIO_DEVICES_RESPONSE_CHANNEL, { requestId, ok, payload, error }) as Promise<void>
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('voxflow', api)
  } catch (error) {
    console.error('[preload] contextBridge 暴露失败', error)
  }
} else {
  // @ts-ignore (define in dts)
  window.voxflow = api
}
