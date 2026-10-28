/**
 * 音频设备枚举 —— 主进程侧。
 *
 * Rust 版用 cpal 枚举输入设备。Electron 主进程无对应 API，
 * 改由渲染进程用 `navigator.mediaDevices.enumerateDevices()` 枚举（Web 标准），
 * 主进程中继。设备 label 需要麦克风权限，未授权时 label 为空（与浏览器行为一致）。
 */

import { rendererRequest, registerResponseHandler, resolveRequest } from './renderer-request'

export const AUDIO_DEVICES_COMMAND_CHANNEL = 'audio-devices:command'
export const AUDIO_DEVICES_RESPONSE_CHANNEL = 'audio-devices:response'

export interface AudioDeviceInfo {
  id: string
  name: string
  channels: number
  isDefault: boolean
}

export interface AudioDevicesResult {
  status: 'audio_devices'
  devices: AudioDeviceInfo[]
  current: string
  currentName: string
}

/** 注册 IPC 响应通道 */
export function registerAudioDevicesIpc(): void {
  registerResponseHandler(AUDIO_DEVICES_RESPONSE_CHANNEL, (requestId, ok, payload, error) => {
    resolveRequest(requestId, ok, payload, error)
  })
}

/** 列出音频输入设备 */
export function listAudioDevices(): Promise<AudioDevicesResult> {
  return rendererRequest<AudioDevicesResult>(
    AUDIO_DEVICES_COMMAND_CHANNEL,
    { action: 'list' },
    8000
  )
}
