/**
 * 麦克风采集 —— 主进程侧。
 *
 * Rust 版用 cpal 在**主进程线程内**持有音频流（cpal::Stream 非 Send，必须同线程创建/销毁）。
 * Electron 主进程没有音频栈，因此采集放在**渲染进程**（getUserMedia + AudioContext），
 * 主进程只做中继：
 *
 *   主进程 ──capture:command(start|stop)──▶ 渲染进程
 *   渲染进程 ──capture:response──────────▶ 主进程（按 requestId 配对）
 *
 * 渲染进程采集后把 16kHz 单声道 Float32 样本回传；主进程负责写 WAV 文件。
 */

import { rendererRequest, registerResponseHandler, resolveRequest } from './renderer-request'

/** 采集通道名（渲染进程监听） */
export const CAPTURE_COMMAND_CHANNEL = 'capture:command'
/** 采集响应通道名（渲染进程回传） */
export const CAPTURE_RESPONSE_CHANNEL = 'capture:response'

export interface CaptureResult {
  /** 16kHz 单声道样本 */
  samples: Float32Array
  sampleRate: number
  /** 录音时长（秒） */
  seconds: number
  /** 峰值音量（0..1） */
  peak: number
}

/** 注册 IPC 响应通道（主进程入口调用一次） */
export function registerCaptureIpc(): void {
  registerResponseHandler(CAPTURE_RESPONSE_CHANNEL, (requestId, ok, payload, error) => {
    resolveRequest(requestId, ok, payload, error)
  })
}

/** 开始录音 */
export function startCapture(): Promise<CaptureResult> {
  return rendererRequest<CaptureResult>(
    CAPTURE_COMMAND_CHANNEL,
    { action: 'start' },
    5000
  )
}

/** 停止录音并取回样本 */
export function stopCapture(): Promise<CaptureResult> {
  return rendererRequest<CaptureResult>(
    CAPTURE_COMMAND_CHANNEL,
    { action: 'stop' },
    15000
  )
}
