/**
 * 音频文件转写 + 多格式导出 —— 对齐 Rust 版 `src-tauri/src/inference/commands.rs`。
 *
 * 流程：
 *  1. 解码音频到 16kHz 单声道 float32（WAV 走内置快速路径，其他走 ffmpeg）
 *  2. 引擎就绪：复用当前已加载引擎；无则按用户上次选择加载
 *  3. 转写：长音频自动分批（≤60s 单次，>60s 滑动窗口 60s+8s 重叠）
 *  4. 导出（txt/srt/vtt/json/lrc）——可选，指定导出目录才写文件
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { basename, extname, join } from 'path'
import { decodeAny } from '../audio'
import { registry } from './registry'
import { transcribeLong, type ProgressFn } from './transcribe'

export interface TranscribeResult {
  text: string
  duration: number
  model: string
  saved_path?: string
}

/** 带进度回调的转写 */
export async function transcribeFileWithProgress(
  filePath: string,
  exportDir: string | undefined,
  exportFormat: string | undefined,
  onProgress: ProgressFn = () => {}
): Promise<TranscribeResult> {
  if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`)

  // 1. 解码音频（多格式）
  const { samples, sampleRate } = await decodeAny(filePath)
  if (samples.length === 0) return { text: '', duration: 0, model: '' }
  const duration = samples.length / sampleRate

  // 2. 引擎就绪：复用当前已加载引擎；无则按用户上次选择加载
  const reg = registry()
  if (!reg.activeEngine()) {
    await reg.loadRequestedAsr(() => {})
  }
  const engine = reg.activeEngine()
  if (!engine) throw new Error('ASR 引擎加载失败')

  // 3. 转写：长音频自动分批
  const text = await transcribeLong(engine, samples, sampleRate, onProgress)

  // 4. 导出（可选）
  const savedPath = exportDir
    ? saveTranscript(text, filePath, exportDir, exportFormat ?? 'txt', duration)
    : undefined

  return {
    text,
    duration: Math.round(duration * 100) / 100,
    model: engine.currentModel(),
    ...(savedPath ? { saved_path: savedPath } : {})
  }
}

/** 保存转写结果到导出目录（txt/srt/vtt/json/lrc）；文件名 = 源音频文件名 + 格式后缀 */
export function saveTranscript(
  text: string,
  src: string,
  exportDir: string,
  format: string,
  duration: number
): string {
  try {
    mkdirSync(exportDir, { recursive: true })
  } catch (e) {
    throw new Error(`创建导出目录失败: ${e instanceof Error ? e.message : String(e)}`)
  }

  const stem = basename(src, extname(src)) || 'transcript'
  const outPath = join(exportDir, `${stem}.${format}`)

  let content: string
  switch (format) {
    case 'srt':
      content = toSrt(text, duration)
      break
    case 'vtt':
      content = toVtt(text, duration)
      break
    case 'json':
      content = `{"text": ${JSON.stringify(text)},"duration": ${duration.toFixed(2)},"source": ${JSON.stringify(src)}}`
      break
    case 'lrc':
      content = toLrc(text, duration)
      break
    default:
      content = text // txt 默认
  }

  try {
    writeFileSync(outPath, content, 'utf-8')
  } catch (e) {
    throw new Error(`写入导出文件失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  return outPath
}

/** 简单 SRT 字幕：整段文本作为一条（0 → 音频时长） */
export function toSrt(text: string, duration: number): string {
  return `1\n00:00:00,000 --> ${formatSrtTime(duration)}\n${text.trim()}\n`
}

/** 简单 VTT：整段文本作为一条 */
export function toVtt(text: string, duration: number): string {
  return `WEBVTT\n\n00:00:00.000 --> ${formatVttTime(duration)}\n${text.trim()}\n`
}

/** 简单 LRC：整段文本作为一条 */
export function toLrc(text: string, duration: number): string {
  const mm = Math.floor(duration / 60)
  const ss = Math.floor(duration % 60)
  return `[${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.00]${text.trim()}\n`
}

export function formatSrtTime(secs: number): string {
  const totalMs = Math.floor(secs * 1000)
  const ms = totalMs % 1000
  const totalS = Math.floor(totalMs / 1000)
  const s = totalS % 60
  const m = Math.floor(totalS / 60) % 60
  const h = Math.floor(totalS / 3600)
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3, '0')}`
}

export function formatVttTime(secs: number): string {
  const totalMs = Math.floor(secs * 1000)
  const ms = totalMs % 1000
  const totalS = Math.floor(totalMs / 1000)
  const s = totalS % 60
  const m = Math.floor(totalS / 60) % 60
  const h = Math.floor(totalS / 3600)
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(ms).padStart(3, '0')}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
