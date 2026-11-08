/**
 * FFI worker 的通用消息契约（纯数据，零依赖）。
 *
 * 这一层只描述「进程边界上长什么样」：命令带编号、应答按编号配对、
 * 阶段事件单独走一路。命令的具体载荷由各引擎自己定义（见各自 protocol.ts）。
 *
 * 与具体引擎无关，所以 llama.cpp / sherpa-onnx / 未来的其它 FFI 引擎共用。
 */

import type { AsrStage } from '../engine'

/** 主进程 → worker 的命令（编号由 host 统一维护） */
export interface WorkerCommand {
  /** 请求编号：应答按它配对 */
  id: number
  /** 命令种类（由各引擎自定义，如 'load' / 'transcribe'） */
  kind: string
  /** 命令载荷 */
  payload?: unknown
}

/** worker → 主进程的事件 */
export type WorkerEvent =
  /** 阶段上报（驱动前端进度条） */
  | { kind: 'stage'; stage: AsrStage }
  /** 命令应答 */
  | { kind: 'reply'; id: number; ok: true; payload: unknown }
  | { kind: 'reply'; id: number; ok: false; error: string }
