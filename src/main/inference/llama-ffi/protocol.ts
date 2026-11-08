/**
 * 主进程 ↔ FFI worker 的消息契约（纯数据，零依赖）。
 *
 * 这一层是「进程边界」的唯一描述：worker 只认这些消息，主进程只发这些消息。
 * 换传输方式（utilityProcess / 未来别的 IPC）时只需替换 host 的实现，
 * worker 与会话层完全不用动。
 */

import type { AsrStage } from '../engine'

/** 加载参数（主进程 → worker） */
export interface LoadRequest {
  /** 模型的逻辑名（展示用，如 Qwen3-ASR-0.6B） */
  name: string
  /** llama.cpp 运行时目录（含 llama.dll / mtmd.dll / ggml*.dll） */
  libsDir: string
  /** GGUF 主模型绝对路径 */
  modelPath: string
  /** mmproj 绝对路径；该模型不需要时为空串 */
  mmprojPath: string
  /** 推理设备 */
  device: 'cuda' | 'cpu'
  /** 上下文长度 */
  ctxSize: number
}

/** 转写参数（主进程 → worker） */
export interface TranscribeRequest {
  /** PCM 采样（[-1, 1]） */
  pcm: Float32Array
  /** 采样率 */
  sampleRate: number
  /** 上文（可选，用于带上下文的转写） */
  context: string
}

/** 主进程 → worker 的命令体（不含 id：编号由 host 统一维护） */
export type WorkerCommandBody =
  | { kind: 'load'; payload: LoadRequest }
  | { kind: 'unload' }
  | { kind: 'transcribe'; payload: TranscribeRequest }

/** 主进程 → worker 的命令（带编号，用于应答配对） */
export type WorkerCommand = { id: number } & WorkerCommandBody

/** worker → 主进程的事件 */
export type WorkerEvent =
  /** 阶段上报（驱动前端进度条） */
  | { kind: 'stage'; stage: AsrStage }
  /** 命令应答 */
  | { kind: 'reply'; id: number; ok: true; payload: unknown }
  | { kind: 'reply'; id: number; ok: false; error: string }

/** worker 的启动参数 */
export interface WorkerBootstrap {
  /** 运行时目录 */
  libsDir: string
  /** 挂载的模型（可选：worker 启动即加载，省一次往返） */
  model?: LoadRequest
}
