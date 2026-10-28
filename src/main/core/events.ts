/**
 * 事件总线 —— 对齐 Rust 版的两个事件通道：
 *
 * - `sidecar://event`：主总线，JSON payload，用 `status` 字段做判别联合。
 *   前端 `useSidecarEvents.ts` 按 `status` 分发，共约 39 个取值。
 * - `asr://status`：热键录音状态，裸字符串（"idle" | "recording" | "recognizing"）。
 */

import { BrowserWindow } from 'electron'

export const SIDECAR_EVENT = 'voxflow:sidecar-event'
export const ASR_STATUS_EVENT = 'voxflow:asr-status'

export type AsrStatus = 'idle' | 'recording' | 'recognizing'

/** status_snapshot 的单调递增序号（前端据此对账，跨引擎共用） */
let statusSeq = 0

export function nextStatusSeq(): number {
  return ++statusSeq
}

/** 向所有窗口广播 `sidecar://event` */
export function emitSidecar(payload: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(SIDECAR_EVENT, payload)
    }
  }
}

/** 向所有窗口广播 `asr://status` */
export function emitAsrStatus(status: AsrStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(ASR_STATUS_EVENT, status)
    }
  }
}

/** 便捷：发送带 status 字段的 sidecar 事件 */
export function emitStatus(status: string, extra: Record<string, unknown> = {}): void {
  emitSidecar({ status, ...extra })
}
