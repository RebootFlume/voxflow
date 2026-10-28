/**
 * 克隆参考音频的录音采集（16kHz 单声道 wav）
 * —— 对齐 Rust 版 `src-tauri/src/tts/reference_audio.rs`。
 *
 * 为什么需要：克隆音色原本只能"选文件"——用户手上没有合适的参考音频时，
 * 等于功能不可用。这里复用录音链路录一段固定时长的参考音。
 *
 * 与 Rust 版的差异：Rust 用 cpal 直接在主进程采集；Electron 主进程没有音频栈，
 * 采集走渲染进程（getUserMedia），主进程只做中继并负责落盘 WAV。
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { recordCapture } from '../system/capture'
import { writeWav } from '../audio/wav'

/** 默认时长（秒）与允许区间 */
export const DEFAULT_SECONDS = 6
export const MIN_SECONDS = 3
export const MAX_SECONDS = 30
/** 采样率（引擎侧的参考音频口径） */
export const SAMPLE_RATE = 16000
/** 数据目录里保留的参考音个数（每次录音写一个新文件，必须清理否则无限堆积） */
export const KEEP_FILES = 5

/** 时长钳制（纯函数）：NaN/非正数用默认值，否则收敛到 [MIN, MAX] */
export function clampSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_SECONDS
  return Math.min(Math.max(seconds, MIN_SECONDS), MAX_SECONDS)
}

/**
 * 录制并落盘到 `dir`，返回 `{ path, seconds, sample_rate, peak }`。
 *
 * `peak` 供前端提示"没录到声音"。
 */
export async function recordTo(
  dir: string,
  seconds: number
): Promise<{ path: string; seconds: number; sample_rate: number; peak: number }> {
  const dur = clampSeconds(seconds)

  const result = await recordCapture(dur)
  const samples = result.samples

  // 半秒以下视为没录上（设备打不开时 start 可能"成功"却拿不到数据）
  if (samples.length < SAMPLE_RATE / 2) {
    throw new Error(`录音过短（${samples.length} 个采样），请检查麦克风`)
  }
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i])
    if (v > peak) peak = v
  }

  mkdirSync(dir, { recursive: true })
  const path = join(dir, `ref-${Date.now()}.wav`)
  writeWav(path, samples, SAMPLE_RATE, 1)
  prune(dir, KEEP_FILES)

  return { path, seconds: dur, sample_rate: SAMPLE_RATE, peak }
}

/**
 * 只保留最近 `keep` 个 `ref-*.wav`（best-effort：失败不影响录音）。
 *
 * 文件名是 `ref-<毫秒时间戳>.wav` ⇒ 同目录内**字典序 ≈ 时间序**，无需读文件时间。
 */
export function prune(dir: string, keep: number): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  const files = entries
    .filter((n) => n.startsWith('ref-') && n.endsWith('.wav'))
    .sort()
    .map((n) => join(dir, n))
  if (files.length <= keep) return
  for (const old of files.slice(0, files.length - keep)) {
    rmSync(old, { force: true })
  }
}

/** 参考音目录（音色库目录内） */
export function referenceDir(voicesDir: string): string {
  return existsSync(voicesDir) ? voicesDir : voicesDir
}
