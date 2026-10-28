/**
 * 主进程 → 渲染进程 请求中继。
 *
 * Electron 主进程没有音频设备枚举、麦克风采集这类能力（属渲染进程 / Web API），
 * 因此需要主进程主动向渲染进程发请求并等回执。统一封装在此，避免各模块重复实现
 * requestId 配对与超时兜底。
 */

import { BrowserWindow, ipcMain } from 'electron'

export interface PendingRequest<T> {
  resolve: (value: T) => void
  reject: (reason: Error) => void
}

let requestSeq = 0
const pending = new Map<number, PendingRequest<unknown>>()

/** 取第一个可用窗口（隐藏到托盘时窗口仍在，只是不可见） */
function targetWindow(): Electron.BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows()
  return windows.find((w) => !w.isDestroyed()) ?? null
}

/**
 * 向渲染进程发一个请求并等待回执。
 *
 * @param channel 渲染进程监听的 IPC 通道
 * @param payload 请求载荷（会带上 requestId）
 * @param timeoutMs 超时兜底
 */
export function rendererRequest<T>(
  channel: string,
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<T> {
  const win = targetWindow()
  if (!win) return Promise.reject(new Error('没有可用的渲染进程窗口'))

  const requestId = ++requestSeq
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, { resolve, reject } as PendingRequest<unknown>)
    win.webContents.send(channel, { ...payload, requestId })
    setTimeout(() => {
      if (pending.delete(requestId)) reject(new Error('渲染进程响应超时'))
    }, timeoutMs)
  })
}

/**
 * 注册回执通道：渲染进程用 `ipcRenderer.invoke(responseChannel, {...})` 应答。
 */
export function registerResponseHandler(
  responseChannel: string,
  handler: (requestId: number, ok: boolean, payload: unknown, error?: string) => void
): void {
  ipcMain.handle(responseChannel, (_event, payload: {
    requestId: number
    ok: boolean
    payload?: unknown
    error?: string
  }) => {
    handler(payload.requestId, payload.ok, payload.payload ?? {}, payload.error)
  })
}

/** 渲染进程应答（按 requestId 配对） */
export function resolveRequest(requestId: number, ok: boolean, payload: unknown, error?: string): void {
  const p = pending.get(requestId)
  if (!p) return
  pending.delete(requestId)
  if (ok) {
    p.resolve(payload)
  } else {
    p.reject(new Error(error ?? '操作失败'))
  }
}
