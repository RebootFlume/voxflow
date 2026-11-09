/**
 * TTS 命令实现 —— 对齐 Rust 版 `src-tauri/src/tts/commands.rs`。
 *
 * - 单命令 `rust_load_tts_model`（registry 路由）。
 * - 能力数据来自描述符（语言 / 音色 / 克隆），不扫废弃目录。
 * - `rust_synthesize` 按引擎返回的真实采样率写盘（不硬编码 24k）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { emitSidecar } from '../core/events'
import { setTtsBusy } from '../api-server'
import { getDataRoot } from '../core/data-root'
import { findSpec, modelRef } from '../models/model-manager'
import type { PresetSpec } from '../models/spec-data'
import { MAX_CHARS_PER_CHUNK, splitText } from './chunk'
import { ttsRegistry } from './registry'
import * as voices from './voices'
import { recordTo } from './reference-audio'
import { TtsCancel, type SynthAudio, type TtsEngine } from './traits'

/** 全局取消令牌（与 `rust_cancel_tts` 共用） */
export const ttsCancel = new TtsCancel()

/** 音色库目录（数据根下 `tts-voices/`） */
export function voicesDir(): string {
  return join(getDataRoot(), voices.DIR_NAME)
}

/** 进度事件 payload（形状是前后端契约，前端按 chunk/chunks 显示） */
export function ttsProgressPayload(done: number, total: number): Record<string, unknown> {
  return {
    status: 'tts_progress',
    chunk: done,
    chunks: total,
    progress: done / Math.max(total, 1)
  }
}

/** 说话人列表：speakers.json 优先（名字 + 数量 = 列表长度），否则生成 0..count 编号 */
function speakerList(dir: string, preset: PresetSpec): { sid: number; name: string }[] {
  // 内联音色名（模型族的 voice_id 预设）：名字即 voice_id，sid 仅作序号
  if (preset.speakers && preset.speakers.length > 0) {
    return preset.speakers.map((name, i) => ({ sid: i, name }))
  }
  if (preset.speakersFile) {
    try {
      const data = readFileSync(join(dir, preset.speakersFile), 'utf-8')
      const list = JSON.parse(data) as { sid: number; name: string }[]
      if (Array.isArray(list) && list.length > 0) return list
    } catch {
      // 读不到就退回编号列表
    }
  }
  return Array.from({ length: preset.count }, (_, i) => ({ sid: i, name: `speaker ${i}` }))
}

/** 加载 TTS 模型（唯一权威路由：展示名 / 引擎 id / 目录名均可） */
export async function loadTtsModel(
  modelPath: string,
  device: string
): Promise<Record<string, unknown>> {
  const reg = ttsRegistry()
  try {
    const { framework, model } = await reg.load(modelPath, device)
    emitSidecar({
      status: 'model_ready',
      kind: 'tts',
      model,
      framework,
      device
    })
    return { status: 'loaded', model, framework, device }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    emitSidecar({ status: 'model_error', kind: 'tts', model: modelPath, msg })
    throw e
  }
}

/** 卸载当前 TTS 模型（释放引擎，可随后删除模型） */
export async function unloadTtsModel(): Promise<Record<string, unknown>> {
  await ttsRegistry().unload()
  return { status: 'unloaded' }
}

/**
 * 设置自然语言音色描述（audio.cpp 的 instruct）。
 *
 * 与克隆互不干扰：描述可以单独用，也可以和预设音色一起用；空串 = 关闭。
 */
export async function setTtsInstruct(text: string): Promise<Record<string, unknown>> {
  const engine = ttsRegistry().active()
  if (!engine) throw new Error('TTS 模型未加载')
  if (!engine.setInstruct) throw new Error('当前引擎不支持音色描述')
  engine.setInstruct(text)
  return { status: 'ok', instruct: text.trim() }
}

/** 设置语音克隆参数（参考音频 + 参考文本；仅克隆模型支持） */
export async function setTtsCloneVoice(
  audioPath: string,
  referenceText: string
): Promise<Record<string, unknown>> {
  const engine = ttsRegistry().active()
  if (!engine) throw new Error('TTS 模型未加载')
  await engine.setCloneVoice(audioPath, referenceText)
  return { status: 'ok', reference_audio: audioPath, reference_text: referenceText }
}

/**
 * 清除语音克隆参数（回到预设音色模式）。
 *
 * 两处都要清，缺一不可：
 * - 引擎侧（`clearCloneVoice`）——否则合成仍带着参考音；
 * - 音色库的 `active_id`——否则下次 TTS 模型就绪时按它恢复，会把用户**刚取消的克隆装回来**。
 */
export async function clearTtsCloneVoice(): Promise<Record<string, unknown>> {
  ttsRegistry().active()?.clearCloneVoice()
  voices.clearActive(voicesDir())
  return { status: 'ok' }
}

/** 切换 TTS 语言（按模型描述符校验） */
export async function setTtsLanguage(language: string): Promise<Record<string, unknown>> {
  const lang = language.trim().toLowerCase()
  const engine = ttsRegistry().active()
  if (!engine) throw new Error('TTS 模型未加载')
  await engine.setLanguage(lang)
  return { language: lang }
}

/** 查询当前 TTS 模型的说话人列表（描述符驱动） */
export async function listTtsSpeakers(): Promise<Record<string, unknown>> {
  const reg = ttsRegistry()
  const model = reg.loadedModel()
  const spec = findSpec(model)
  if (!spec || spec.kind !== 'tts') {
    return { model, num_speakers: 0, speakers: [] }
  }
  const preset =
    spec.voiceMode.type === 'preset'
      ? spec.voiceMode
      : spec.voiceMode.type === 'presetAndClone'
        ? spec.voiceMode.preset
        : null
  const speakers = preset ? speakerList(reg.modelDir(spec), preset) : []
  return { model: modelRef(spec), num_speakers: speakers.length, speakers }
}

/**
 * 逐段合成并拼接 PCM。返回 [样本, 采样率, 是否被取消]。
 *
 * - 取消只在**段与段之间**生效；命中即返回空样本 + true，调用方不落盘。
 * - 单段失败重试一次（子进程偶发启动失败）；仍失败 ⇒ 整单失败，错误点名段号与段首文本。
 * - 采样率不一致视为异常（同一模型不该变），直接失败而不是拼出变速音频。
 */
async function synthesizeChunks(
  engine: TtsEngine,
  cancel: TtsCancel,
  chunks: string[],
  voice: string,
  onProgress: (done: number, total: number) => void
): Promise<{ samples: Int16Array; sampleRate: number; cancelled: boolean }> {
  const total = chunks.length
  const parts: Int16Array[] = []
  let sampleRate = 0
  let totalLength = 0

  for (let i = 0; i < chunks.length; i++) {
    const part = chunks[i]
    if (cancel.isCancelled()) {
      return { samples: new Int16Array(0), sampleRate: 0, cancelled: true }
    }

    let audio: SynthAudio
    try {
      audio = await engine.synthesize(part, voice)
    } catch (first) {
      const firstMsg = first instanceof Error ? first.message : String(first)
      try {
        audio = await engine.synthesize(part, voice)
      } catch (second) {
        const secondMsg = second instanceof Error ? second.message : String(second)
        const head = [...part].slice(0, 20).join('')
        throw new Error(
          `第 ${i + 1}/${total} 段合成失败（“${head}…”）：${firstMsg}；重试一次后仍失败：${secondMsg}`
        )
      }
    }

    if (sampleRate === 0) {
      sampleRate = audio.sampleRate
    } else if (audio.sampleRate !== sampleRate) {
      throw new Error(
        `分段采样率不一致（${sampleRate} vs ${audio.sampleRate}），已中止以免拼出变速音频`
      )
    }
    parts.push(audio.samples)
    totalLength += audio.samples.length
    onProgress(i + 1, total)
  }

  const merged = new Int16Array(totalLength)
  let offset = 0
  for (const p of parts) {
    merged.set(p, offset)
    offset += p.length
  }
  return { samples: merged, sampleRate, cancelled: false }
}

/** 当前本地时间 HHMMSS（对齐 chrono 的 `%H%M%S`） */
function localTimeStamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 合成 + 落盘（注册表锁覆盖整个合成，保持 API server 的 503 忙碌语义） */
export async function synthesize(
  text: string,
  voice: string,
  exportDir: string,
  onProgress: (done: number, total: number) => void
): Promise<Record<string, unknown>> {
  if (!text) throw new Error('text is empty')

  const chunks = splitText(text, MAX_CHARS_PER_CHUNK)
  if (chunks.length === 0) throw new Error('text is empty')

  const reg = ttsRegistry()
  const engine = reg.active()
  if (!engine) throw new Error('TTS 模型未加载，请先在「模型与设备」中加载模型')

  ttsCancel.begin()
  // UI 合成期间对外 HTTP API 返回 503（对齐 Rust 的 try_lock 忙碌语义）
  setTtsBusy(true)
  let outcome: { samples: Int16Array; sampleRate: number; cancelled: boolean }
  try {
    outcome = await synthesizeChunks(engine, ttsCancel, chunks, voice, onProgress)
  } finally {
    setTtsBusy(false)
    ttsCancel.end()
  }

  if (outcome.cancelled) {
    // 被取消：不写文件、不算失败（前端按 cancelled 标记任务为「已取消」）
    return { text, voice, chunks: chunks.length, cancelled: true }
  }
  if (outcome.samples.length === 0) throw new Error('合成音频为空')

  // 建目录改异步：Electron 主线程做同步 IO 会让窗口卡住（长文本合成时尤其明显）
  if (!existsSync(exportDir)) await mkdir(exportDir, { recursive: true })

  const ts = localTimeStamp()
  const safeText = [...text]
    .slice(0, 20)
    .filter((c) => /[\p{L}\p{N}]/u.test(c) || c === ' ' || /[\u{4e00}-\u{9fff}]/u.test(c))
    .join('')
  const fileName = safeText.trim() ? `${safeText.trim()}_${ts}.wav` : `tts_${ts}.wav`
  const outPath = join(exportDir, fileName)

  await writeInt16Wav(outPath, outcome.samples, Math.max(outcome.sampleRate, 1))

  const fileSize = (await stat(outPath)).size
  const sizeStr =
    fileSize > 1024 * 1024
      ? `${(fileSize / 1024 / 1024).toFixed(1)} MB`
      : `${Math.floor(fileSize / 1024)} KB`

  return {
    text,
    voice,
    sample_rate: outcome.sampleRate,
    saved_path: outPath,
    size: sizeStr,
    chunks: chunks.length,
    cancelled: false
  }
}

/** 写 16bit 单声道 WAV（与 hound 的 WavSpec{channels:1, bits:16, int} 一致）
 *
 * 采样数据一次性转成 Buffer 再异步落盘：
 * 逐样本 `writeInt16LE` 是 N 次 JS 调用，长文本合成时会把 Electron 主线程占住数秒
 * （表现为整个窗口无响应）；`writeFile` 走线程池，不占主线程。
 */
async function writeInt16Wav(path: string, samples: Int16Array, sampleRate: number): Promise<void> {
  const dataBytes = samples.length * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)

  // Int16Array → 原始字节：一次 memcpy 取代逐样本写入（长度按字节算，避免尾字节错位）
  const body = Buffer.from(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength))
  await writeFile(path, Buffer.concat([header, body]))
}

/** 取消正在进行的合成（段边界生效） */
export function cancelTts(): { cancelled: boolean } {
  return { cancelled: ttsCancel.request() }
}

// ── 克隆音色库 ───────────────────────────────────────────────────────────────

/** 音色条目 → 前端 JSON（字段名与 Tauri 版一致） */
function voiceJson(dir: string, v: voices.Voice): Record<string, unknown> {
  return {
    id: v.id,
    name: v.name,
    note: v.note,
    reference_text: v.referenceText,
    audio_path: voices.pathOf(dir, v),
    created_ms: v.createdMs
  }
}

/** 列出音色库（含当前选中 id） */
export function listVoices(): Record<string, unknown> {
  const dir = voicesDir()
  const lib = voices.load(dir)
  return {
    dir,
    active_id: lib.activeId,
    voices: lib.voices.map((v) => voiceJson(dir, v))
  }
}

/** 把一个音频（录音草稿或用户上传）收进音色库：命名后成为可复用条目 */
export function addVoice(
  sourcePath: string,
  name: string,
  note: string,
  referenceText: string
): { id: string } {
  const voice = voices.add(voicesDir(), sourcePath, name, note, referenceText)
  return { id: voice.id }
}

/** 改名 / 改说明 / 改参考文本 */
export function updateVoice(
  id: string,
  name: string,
  note: string,
  referenceText: string
): { ok: true } {
  voices.update(voicesDir(), id, name, note, referenceText)
  return { ok: true }
}

/**
 * 删除条目。若删的正是当前选中：**先清引擎的克隆参数，再删库**
 * （否则库里没了、引擎还在用旧的参考音合成）。
 */
export function removeVoice(id: string): { ok: true } {
  const dir = voicesDir()
  const lib = voices.load(dir)
  if (lib.activeId === id) {
    ttsRegistry().active()?.clearCloneVoice()
  }
  voices.remove(dir, id)
  return { ok: true }
}

/**
 * 应用某个音色：**先把参数成功下发给引擎，才记为"当前选中"**。
 *
 * 顺序不可反（否则库里显示已选中、引擎里根本没有这份参数 = 谎报）。
 */
export async function useVoice(id: string): Promise<{ ok: true; name: string }> {
  const dir = voicesDir()
  const lib = voices.load(dir)
  const voice = lib.voices.find((v) => v.id === id)
  if (!voice) throw new Error(`音色不存在: ${id}`)
  const path = voices.pathOf(dir, voice)
  const engine = ttsRegistry().active()
  if (!engine) throw new Error('TTS 模型未加载')
  // 引擎侧能力校验（非克隆模型拒绝）失败时，直接返回错误、不落库
  await engine.setCloneVoice(path, voice.referenceText)
  voices.setActive(dir, id)
  return { ok: true, name: voice.name }
}

/**
 * 录制 TTS 克隆参考音频（16kHz 单声道 wav）。
 * seconds 由主进程钳制到 3–30；peak = 峰值，< 0.01 视为基本静音（UI 提示重录）。
 */
export async function recordTtsReference(seconds: number): Promise<{
  path: string
  seconds: number
  sample_rate: number
  peak: number
}> {
  return recordTo(voicesDir(), seconds)
}
