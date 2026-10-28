/**
 * WAV 音频读写 —— 对齐 Rust 版 `src-tauri/src/audio/wav.rs`（hound crate 行为）。
 *
 * 解码支持 16 / 24 / 32 位 PCM（整型）；输出统一为 16kHz 单声道 float32。
 */

import { readFileSync, writeFileSync } from 'fs'
import { resampleLinear } from './resample'

export const SAMPLE_RATE_16K = 16000
export const SAMPLE_RATE_24K = 24000
export const SAMPLE_RATE_48K = 48000

export interface DecodedWav {
  samples: Float32Array
  sampleRate: number
  channels: number
}

/** 读取 WAV 文件，返回 (samples, sampleRate, channels) */
export function readWav(path: string): DecodedWav {
  return parseWav(readFileSync(path))
}

/** 从字节流解析 WAV */
export function parseWav(data: Buffer): DecodedWav {
  if (data.length < 12) throw new Error('WAV parse failed: 文件过短')

  let offset = 12
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let audioFormat = 1
  let dataStart = -1
  let dataLength = 0

  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    const body = offset + 8

    if (id === 'fmt ') {
      audioFormat = data.readUInt16LE(body)
      channels = data.readUInt16LE(body + 2)
      sampleRate = data.readUInt32LE(body + 4)
      bitsPerSample = data.readUInt16LE(body + 14)
    } else if (id === 'data') {
      dataStart = body
      dataLength = Math.min(size, data.length - body)
      break
    }

    // chunk 按偶数字节对齐
    offset = body + size + (size % 2)
  }

  if (dataStart < 0) throw new Error('WAV parse failed: 缺少 data 块')
  if (!channels) throw new Error('WAV parse failed: 缺少 fmt 块')

  // 只支持整型 PCM（hound 的 into_samples::<i16/i32> 对 float 格式不适用）
  if (audioFormat === 0xfffe || audioFormat === 3) {
    throw new Error(`unsupported bits per sample: ${bitsPerSample}`)
  }

  let samples: Float32Array
  switch (bitsPerSample) {
    case 16:
      samples = new Float32Array(Math.floor(dataLength / 2))
      for (let i = 0; i < samples.length; i++) {
        samples[i] = data.readInt16LE(dataStart + i * 2) / 32768.0
      }
      break
    case 24:
      samples = new Float32Array(Math.floor(dataLength / 3))
      for (let i = 0; i < samples.length; i++) {
        const o = dataStart + i * 3
        const raw = (data[o] | (data[o + 1] << 8) | (data[o + 2] << 16)) << 8
        samples[i] = raw / 8388608.0
      }
      break
    case 32:
      samples = new Float32Array(Math.floor(dataLength / 4))
      for (let i = 0; i < samples.length; i++) {
        samples[i] = data.readInt32LE(dataStart + i * 4) / 2147483648.0
      }
      break
    default:
      throw new Error(`unsupported bits per sample: ${bitsPerSample}`)
  }

  return { samples, sampleRate, channels }
}

/** 写入 WAV 文件（16bit PCM） */
export function writeWav(
  path: string,
  samples: Float32Array,
  sampleRate: number,
  channels = 1
): void {
  const dataBytes = samples.length * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)

  const body = Buffer.alloc(dataBytes)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i])) * 32767
    body.writeInt16LE(Math.round(v), i * 2)
  }

  writeFileSync(path, Buffer.concat([header, body]))
}

/** 多声道转单声道（取均值） */
export function toMono(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return samples
  const frames = Math.floor(samples.length / channels)
  const out = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += samples[f * channels + c]
    out[f] = sum / channels
  }
  return out
}

/**
 * 从字节流解码音频，返回 (samples_16kHz_mono, 16000)。
 * 直接基于内存解码，不写临时文件。
 */
export function decodeWav(data: Buffer): { samples: Float32Array; sampleRate: number } {
  const { samples, sampleRate, channels } = parseWav(data)
  const mono = channels > 1 ? toMono(samples, channels) : samples
  const resampled =
    sampleRate !== SAMPLE_RATE_16K ? resampleLinear(mono, sampleRate, SAMPLE_RATE_16K) : mono
  return { samples: resampled, sampleRate: SAMPLE_RATE_16K }
}
