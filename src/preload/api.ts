/**
 * 预加载暴露给渲染进程的 API 类型定义（纯类型，无运行时依赖）。
 * 单独成文件以便渲染进程的 tsconfig（DOM lib）也能安全引用。
 */

export type WindowAction = 'minimize' | 'toggleMaximize' | 'close' | 'hide' | 'show'

export interface DialogOptions {
  /** 'file' 选文件 / 'directory' 选目录 */
  kind?: 'file' | 'directory'
  title?: string
  defaultPath?: string
  /** 扩展名过滤器，如 [{ name: '音频', extensions: ['wav', 'mp3'] }] */
  filters?: { name: string; extensions: string[] }[]
  multiple?: boolean
}

export interface DialogResult {
  canceled: boolean
  /** 选中的路径（multiple=false）或路径数组（multiple=true） */
  paths: string[]
}

export interface VoxFlowAPI {
  /** 调用主进程命令（命令名与 Tauri 版保持一致） */
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>
  /** 订阅主进程事件；返回取消订阅函数（与 Tauri 的 `listen` 语义一致） */
  listen<T = unknown>(
    event: 'sidecar://event' | 'asr://status',
    handler: (payload: T) => void
  ): Promise<() => void>
  /** 文件/目录选择 */
  openDialog(options?: DialogOptions): Promise<DialogResult>
  /** 窗口控制（对应 Tauri 的 getCurrentWindow()） */
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    hide(): Promise<void>
    show(): Promise<void>
  }
  /** 采集请求回执（主进程发起） */
  capture: {
    /** 订阅主进程下发的采集指令（start / stop / record） */
    onCommand(handler: (payload: { action: string; requestId: number; seconds?: number }) => void): void
    respond(requestId: number, ok: boolean, payload?: unknown, error?: string): Promise<void>
  }
  /** 音频设备请求回执（主进程发起） */
  audioDevices: {
    /** 订阅主进程下发的音频设备枚举指令 */
    onCommand(handler: (payload: { action: string; requestId: number }) => void): void
    respond(requestId: number, ok: boolean, payload?: unknown, error?: string): Promise<void>
  }
}
