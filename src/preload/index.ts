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
const ASR_STATUS_CHANNEL = 'voxflow:asr-status'/** 渲染进程 → 主进程：窗口控制 */
const WINDOW_CHANNEL = 'voxflow:window'
/** 渲染进程 → 主进程：文件/目录选择 */
const DIALOG_CHANNEL = 'voxflow:dialog'

/** 采集 / 音频设备：主进程向渲染进程发请求，渲染进程用 invoke 回执 */
const CAPTURE_COMMAND_CHANNEL = 'capture:command'
const CAPTURE_RESPONSE_CHANNEL = 'capture:response'
const AUDIO_DEVICES_COMMAND_CHANNEL = 'audio-devices:command'
const AUDIO_DEVICES_RESPONSE_CHANNEL = 'audio-devices:response'

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
    return Promise.resolve(() => {
      ipcRenderer.removeListener(channel, handler as (_e: IpcRendererEvent, ...args: unknown[]) => void)
    }).then((unlisten) => {
      ipcRenderer.on(channel, (_e: IpcRendererEvent, ...args: unknown[]) => {
        handler(args[0] as T)
      })
      return unlisten
    })
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
      ipcRenderer.on(CAPTURE_COMMAND_CHANNEL, (_e: IpcRendererEvent, payload: { action: string; requestId: number }) => {
        handler(payload)
      })
    },
    respond: (requestId: number, ok: boolean, payload?: unknown, error?: string) =>
      ipcRenderer.invoke(CAPTURE_RESPONSE_CHANNEL, { requestId, ok, payload, error }) as Promise<void>
  },

  audioDevices: {
    onCommand: (handler) => {
      ipcRenderer.on(AUDIO_DEVICES_COMMAND_CHANNEL, (_e: IpcRendererEvent, payload: { action: string; requestId: number }) => {
        handler(payload)
      })
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
