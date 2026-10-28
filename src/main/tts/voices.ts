/**
 * 克隆音色库（Voicebox 式：录音/上传 → 命名 + 说明 → 存为条目 → 点击即用）
 * —— 对齐 Rust 版 `src-tauri/src/tts/voices.rs`。
 *
 * 存储：`<data_root>/tts-voices/`
 * - `voices.json`：索引（条目元数据 + 当前选中 id）
 * - `<id>.<ext>`：音频文件（**文件名 = 条目 id**）
 *
 * 设计要点：
 * - 索引只存**相对文件名**（`file`）⇒ 便携版整体搬目录后仍然有效。
 * - 写索引原子（tmp + rename），不产生半截 JSON。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, extname, join } from 'path'

/** 音色库目录名（数据根下）与索引文件名 */
export const DIR_NAME = 'tts-voices'
export const INDEX_FILE = 'voices.json'

/** 认可的音频扩展名（上传按源扩展保留；不认可的一律按 wav 处理） */
const AUDIO_EXTS = ['wav', 'mp3', 'flac', 'ogg', 'm4a']

/** 一个保存下来的音色条目 */
export interface Voice {
  id: string
  name: string
  note: string
  referenceText: string
  /** 音频文件名（相对音色库目录） */
  file: string
  createdMs: number
}

/** 音色库索引（落盘字段为 snake_case，与 Tauri 版共用同一份 voices.json） */
interface LibraryFile {
  voices: {
    id: string
    name: string
    note: string
    reference_text: string
    file: string
    created_ms: number
  }[]
  active_id: string | null
}

/** 读取索引（缺失/损坏 → 空库：宁可让用户看到空列表，也不因坏文件起不来） */
export function load(dir: string): { voices: Voice[]; activeId: string | null } {
  try {
    const raw = readFileSync(join(dir, INDEX_FILE), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<LibraryFile>
    const voices = (parsed.voices ?? []).map((v) => ({
      id: v.id,
      name: v.name,
      note: v.note ?? '',
      referenceText: v.reference_text ?? '',
      file: v.file,
      createdMs: v.created_ms ?? 0
    }))
    return { voices, activeId: parsed.active_id ?? null }
  } catch {
    return { voices: [], activeId: null }
  }
}

/** 原子写索引（tmp + rename） */
export function save(dir: string, lib: { voices: Voice[]; activeId: string | null }): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    throw new Error(`创建音色库目录失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  const payload: LibraryFile = {
    voices: lib.voices.map((v) => ({
      id: v.id,
      name: v.name,
      note: v.note,
      reference_text: v.referenceText,
      file: v.file,
      created_ms: v.createdMs
    })),
    active_id: lib.activeId
  }
  const tmp = join(dir, `${INDEX_FILE}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
    renameSync(tmp, join(dir, INDEX_FILE))
  } catch (e) {
    throw new Error(`写入音色库索引失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * 是否是我们自己的录音草稿（位于音色库目录内、名为 `ref-*.wav`）。
 *
 * 区分它与"用户上传的文件"是**数据安全**问题：草稿是临时产物、可以移走；
 * 用户自己的文件只能复制。
 */
function isOwnDraft(dir: string, source: string): boolean {
  return source.startsWith(dir) && basename(source).startsWith('ref-')
}

/** 条目音频的绝对路径 */
export function pathOf(dir: string, voice: Voice): string {
  return join(dir, voice.file)
}

function nowMs(): number {
  return Date.now()
}

function extOf(src: string): string {
  const e = extname(src).replace(/^\./, '').toLowerCase()
  return AUDIO_EXTS.includes(e) ? e : 'wav'
}

/**
 * 收进音色库：把 `source`（录音草稿或用户上传的文件）收进库内并落一条索引。
 *
 * 名称必填（"保存才进库、才有名字"是这套流程的地基）。
 *
 * 收进来的方式按来源分两种：我们自己的录音草稿**移走**，用户上传的文件**复制**
 * ——后者若被移走就是从用户自己的目录里凭空消失。
 */
export function add(
  dir: string,
  source: string,
  name: string,
  note: string,
  referenceText: string
): Voice {
  const trimmedName = name.trim()
  if (!trimmedName) throw new Error('音色名称不能为空')
  if (!existsSync(source)) throw new Error(`音频文件不存在: ${source}`)
  mkdirSync(dir, { recursive: true })

  const ext = extOf(source)
  const base = nowMs()
  let seq = 0
  let id = ''
  let file = ''
  for (;;) {
    id = seq === 0 ? `v-${base}` : `v-${base}-${seq}`
    file = `${id}.${ext}`
    if (!existsSync(join(dir, file))) break
    seq++
  }

  const dest = join(dir, file)
  if (isOwnDraft(dir, source)) {
    // 我们自己的录音草稿是临时文件 ⇒ 移走（省一次拷贝，也让草稿目录清空）
    try {
      renameSync(source, dest)
    } catch {
      // 跨卷 rename 失败 → 复制后删源
      copyFileSync(source, dest)
      rmSync(source, { force: true })
    }
  } else {
    // 用户自己的文件（"上传音频"给的）一律**复制**：
    // 绝不能把用户的原文件搬离它原来的目录。
    copyFileSync(source, dest)
  }

  const voice: Voice = {
    id,
    name: trimmedName,
    note: note.trim(),
    referenceText: referenceText.trim(),
    file,
    createdMs: nowMs()
  }
  const lib = load(dir)
  lib.voices.push(voice)
  save(dir, lib)
  pruneOrphans(dir, lib)
  return voice
}

/** 改名 / 改说明 / 改参考文本 */
export function update(
  dir: string,
  id: string,
  name: string,
  note: string,
  referenceText: string
): Voice {
  const trimmedName = name.trim()
  if (!trimmedName) throw new Error('音色名称不能为空')
  const lib = load(dir)
  const voice = lib.voices.find((v) => v.id === id)
  if (!voice) throw new Error(`音色不存在: ${id}`)
  voice.name = trimmedName
  voice.note = note.trim()
  voice.referenceText = referenceText.trim()
  save(dir, lib)
  return { ...voice }
}

/** 删除条目（连带音频文件；若删的正是当前选中，一并清空 active） */
export function remove(dir: string, id: string): void {
  const lib = load(dir)
  const idx = lib.voices.findIndex((v) => v.id === id)
  if (idx < 0) throw new Error(`音色不存在: ${id}`)
  const [voice] = lib.voices.splice(idx, 1)
  rmSync(pathOf(dir, voice), { force: true })
  if (lib.activeId === id) lib.activeId = null
  save(dir, lib)
}

/**
 * 记为当前选中并返回该条目。
 *
 * **调用方必须先把参数成功下发给引擎**，再调本函数 —— 否则库里显示"已选中"而引擎
 * 里根本没有这份克隆参数（谎报）。
 */
export function setActive(dir: string, id: string): Voice {
  const lib = load(dir)
  const voice = lib.voices.find((v) => v.id === id)
  if (!voice) throw new Error(`音色不存在: ${id}`)
  lib.activeId = id
  save(dir, lib)
  return { ...voice }
}

/**
 * 取消"当前选中"（引擎侧已 clear 克隆后调用）。
 *
 * 必须与引擎同步清除：否则下次 TTS 模型就绪时按 `activeId` 恢复，
 * 会把用户刚取消的克隆**又装回来**。
 */
export function clearActive(dir: string): void {
  const lib = load(dir)
  if (lib.activeId === null) return
  lib.activeId = null
  save(dir, lib)
}

/** 当前选中条目（无则 null） */
export function active(dir: string): Voice | null {
  const lib = load(dir)
  if (!lib.activeId) return null
  return lib.voices.find((v) => v.id === lib.activeId) ?? null
}

/**
 * 删除索引未引用的库内音频（孤儿：录了但没保存、或保存前进程被杀）。
 * `ref-*.wav` 是未入库的录音草稿，由 `reference-audio.ts` 的 prune 按数量上限管理，这里不动。
 */
export function pruneOrphans(dir: string, lib: { voices: Voice[] }): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const looksLikeLibraryFile =
      name.startsWith('v-') && AUDIO_EXTS.some((e) => name.endsWith(`.${e}`))
    if (looksLikeLibraryFile && !lib.voices.some((v) => v.file === name)) {
      rmSync(join(dir, name), { force: true })
    }
  }
}
