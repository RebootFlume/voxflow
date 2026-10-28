/**
 * 日志桥接 —— 对齐 Rust 版 `src-tauri/src/log_bridge.rs`。
 * Rust 侧把 `log::` crate 中 target 以 "voxflow" 开头的记录转发到前端，
 * 前端 `useSidecarEvents.ts` 接收 `rust_log` 事件写入 runtimeLogs。
 */

import { emitSidecar } from './events'

export type LogLevel = 'error' | 'warn' | 'info'

function push(level: LogLevel, msg: string, target = 'voxflow'): void {
  emitSidecar({ status: 'rust_log', level, msg, target })
}

export const log = {
  error: (msg: string, target?: string): void => push('error', msg, target),
  warn: (msg: string, target?: string): void => push('warn', msg, target),
  info: (msg: string, target?: string): void => push('info', msg, target)
}
