/**
 * TTS 命令实现 —— 对齐 Rust 版 `src-tauri/src/tts/commands.rs`。
 *
 * - 单命令 `rust_load_tts_model`（registry 路由）。
 * - 能力数据来自描述符（语言 / 音色 / 克隆），不扫废弃目录。
 * - `rust_synthesize` 按引擎返回的真实采样率写盘（不硬编码 24k）。
 */

import { existsSync } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { emitSidecar } from '../core/events'
import { isTtsBusy, setTtsBusy } from '../api-server'
import { getDataRoot } from '../core/data-root'
import { findSpec, modelRef } from '../models/model-manager'
import { speakerList } from './speakers'
import { MAX_CHARS_PER_CHUNK, splitText } from '@shared/tts-chunk'
import { WavStreamWriter } from './wav-writer'
import { ttsRegistry } from './registry'
import * as voices from './voices'
import { recordTo } from './reference-audio'
import { TtsCancel, type SynthAudio, type TtsEngine } from './traits'

/** 全局取消令牌（与 `rust_cancel_tts` 共用） */
export const ttsCancel = new TtsCancel()

/** 未设置导出目录时的落盘位置（数据根下 `tts-output/`） */
const DEFAULT_EXPORT_DIR = 'tts-output'

/**
 * 解析实际落盘目录（未设置 → 数据根下的默认位置）。
 *
 * 单独导出的理由：界面要能把「你没设，我存在这里」显示出来 ——
 * 否则用户合成成功了却不知道去哪找（界面上写着"未设置"）。
 */
export function resolveExportDir(exportDir: string): string {
  return exportDir.trim() || join(getDataRoot(), DEFAULT_EXPORT_DIR)
}

/**
 * 确保导出目录存在并返回它。
 *
 * 为什么需要：`tts-output/` 只在第一次落盘时创建，而用户很可能在合成之前
 * 就想点「打开文件夹」看看存哪 —— 不先建目录的话 shell.openPath 会直接
 * 返回 "Failed to open path"，看起来像功能坏了。
 * 用户自己选的目录同理（可能已被删除/移动）。
 */
export async function ensureExportDir(exportDir: string): Promise<string> {
  const dir = resolveExportDir(exportDir)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * 合成进行中禁止改动引擎参数。
 *
 * 为什么必须有这一道：引擎在**每一段**都重新读 `inner.language` / `inner.instruct` /
 * `sid`，中途改掉会让同一个 WAV 文件前半段是一种语言/音色、后半段是另一种，
 * 而且不会报任何错 —— 用户只是拿到一个"听起来哪里不对"的文件。
 *
 * 前端会把这些控件置灰，但那只是体验层；HTTP API 走的是同一条引擎，
 * 其他调用方照样能改。正确性不能依赖前端记得禁用按钮。
 */
function assertNotSynthesizing(what: string): void {
  if (isTtsBusy()) throw new Error(`合成进行中，无法修改${what}（否则同一个文件前后不一致）`)
}

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
  assertNotSynthesizing('音色描述')
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
  assertNotSynthesizing('克隆音色')
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
  assertNotSynthesizing('克隆音色')
  ttsRegistry().active()?.clearCloneVoice()
  voices.clearActive(voicesDir())
  return { status: 'ok' }
}

/** 切换 TTS 语言（按模型描述符校验） */
export async function setTtsLanguage(language: string): Promise<Record<string, unknown>> {
  assertNotSynthesizing('合成语言')
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
 * 逐段合成并**边合成边写盘**。返回 [采样率, 是否被取消]（字节数从 writer 读）。
 *
 * 为什么不再把所有 PCM 攒在内存里：同一份音频会在内存中存在三份
 * （分段数组 + 合并目标数组 + 写盘 Buffer），峰值 ≈ 音频总长 × 3。
 * 2MB 中文 TXT 能解出 37 小时音频（6GB），峰值 18GB，必然 OOM。
 * 流式写盘后峰值只有「当前这一段」那么大，与文本长度无关。
 *
 * - 取消只在**段与段之间**生效；命中即停止，已写入的部分由调用方决定去留。
 * - 单段失败重试一次（子进程偶发启动失败）；仍失败 ⇒ 整单失败，错误点名段号与段首文本。
 * - 采样率不一致视为异常（同一模型不该变），由 writer 内部拦截并抛错。
 */
async function synthesizeChunks(
  engine: TtsEngine,
  cancel: TtsCancel,
  writer: WavStreamWriter,
  chunks: string[],
  voice: string,
  onProgress: (done: number, total: number) => void
): Promise<{ sampleRate: number; cancelled: boolean }> {
  const total = chunks.length
  let sampleRate = 0

  for (let i = 0; i < chunks.length; i++) {
    const part = chunks[i]
    if (cancel.isCancelled()) {
      return { sampleRate, cancelled: true }
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

    if (sampleRate === 0) sampleRate = audio.sampleRate
    // 立即落盘：这一段之后就不再需要留在内存里
    await writer.append(audio.samples, audio.sampleRate)
    onProgress(i + 1, total)
  }

  return { sampleRate, cancelled: false }
}

/** 当前本地时间 HHMMSS（对齐 chrono 的 `%H%M%S`） */
function localTimeStamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 合成 + 落盘（注册表锁覆盖整个合成，保持 API server 的 503 忙碌语义）。
 *
 * 文件在**第一段产出之前**就创建好了（`WavStreamWriter.create` 先写占位头），
 * 之后每段 PCM 直接追加。内存占用只剩当前这一段。
 */
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

  // 导出目录未设置（试听也走这条路径）→ 落到数据根下的 tts-output。
  // 空串直接 mkdir 会抛 ENOENT: no such file or directory, mkdir ''，
  // 用户在「音色设置」点试听就只看到一句莫名其妙的内核错误。
  const outDir = resolveExportDir(exportDir)
  // 建目录改异步：Electron 主线程做同步 IO 会让窗口卡住（长文本合成时尤其明显）
  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true })

  const ts = localTimeStamp()
  const safeText = [...text]
    .slice(0, 20)
    .filter((c) => /[\p{L}\p{N}]/u.test(c) || c === ' ' || /[\u{4e00}-\u{9fff}]/u.test(c))
    .join('')
  const fileName = safeText.trim() ? `${safeText.trim()}_${ts}.wav` : `tts_${ts}.wav`
  const outPath = join(outDir, fileName)

  const writer = await WavStreamWriter.create(outPath)

  ttsCancel.begin()
  // UI 合成期间对外 HTTP API 返回 503（对齐 Rust 的 try_lock 忙碌语义）
  setTtsBusy(true)
  let outcome: { sampleRate: number; cancelled: boolean }
  try {
    outcome = await synthesizeChunks(engine, ttsCancel, writer, chunks, voice, onProgress)
  } catch (e) {
    // 失败：已写入的部分仍然回填空头 —— 跑了很久才失败时，前面的音频扔掉才是浪费。
    // 一段都没成功（bytes === 0）则删掉这个空壳文件。
    // 把产物路径补进错误信息，否则文件躺在盘上而用户以为什么都没留下。
    const msg = e instanceof Error ? e.message : String(e)
    if (writer.bytes > 0) {
      const ok = await writer.finalize().then(() => true).catch(() => false)
      throw new Error(
        ok ? `${msg}（已保留此前合成好的部分：${outPath}）` : msg
      )
    }
    await writer.discard().catch(() => {})
    throw e
  } finally {
    setTtsBusy(false)
    ttsCancel.end()
  }

  const dataBytes = await writer.finalize()

  if (dataBytes === 0) {
    // 一段都没产出（第一段就被取消）⇒ 不留下 44 字节的空 WAV
    await unlink(outPath).catch(() => {})
    return { text, voice, chunks: chunks.length, cancelled: true }
  }

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
    // 取消后仍然返回已产出的部分（saved_path 有效）：没跑完但能听
    cancelled: outcome.cancelled
  }
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
  assertNotSynthesizing('音色')
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
