/**
 * 音频统一入口 —— 对齐 Rust 版 `src-tauri/src/audio/mod.rs`（规则 12：解码器可插拔）。
 *
 * - WAV（RIFF 头）→ 内置快速路径（无外部依赖）
 * - 其他格式 → ffmpeg 子进程（需系统安装 ffmpeg）
 * 上层只调 `decodeAny`，不感知格式。
 */

import { readFileSync } from 'fs'
import { extname } from 'path'
import { decodeWithFfmpeg, ffmpegAvailable } from './ffmpeg'
import { decodeWav, toMono } from './wav'

export { SAMPLE_RATE_16K, SAMPLE_RATE_24K, SAMPLE_RATE_48K } from './wav'
export { readWav, writeWav, parseWav, decodeWav } from './wav'
export { resample, resampleLinear } from './resample'
export { decodeWithFfmpeg, ffmpegAvailable } from './ffmpeg'

/** 多格式解码入口：读取文件并解码为 16kHz 单声道 float32 */
export async function decodeAny(path: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  const data = readFileSync(path)

  // WAV 快速路径：RIFF 头
  if (data.length >= 4 && data.toString('ascii', 0, 4) === 'RIFF') {
    return decodeWav(data)
  }

  // 其他格式 → ffmpeg 子进程
  if (!(await ffmpegAvailable())) {
    const ext = extname(path).replace(/^\./, '') || '未知'
    throw new Error(`不支持的格式（需要 ffmpeg 才能解码 ${ext}）: 请安装 ffmpeg 并加入 PATH`)
  }
  return decodeWithFfmpeg(path)
}

/** float32 转 int16 PCM */
export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767)
  }
  return out
}

/** int16 PCM 转 float32 */
export function int16ToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768.0
  return out
}

export { toMono }
