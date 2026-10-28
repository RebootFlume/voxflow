#!/usr/bin/env node
/**
 * Rust → TypeScript 模型描述符转换器（一次性工具，产物已入库）。
 *
 * 背景：Tauri 版的模型清单是一张 ~820 行的 Rust 静态表（`src-tauri/src/tts/spec.rs` 的
 * `SPECS`）。手抄 800 行结构化数据极易出错，故用脚本做语法级转换：
 * Rust 字面量 → 等价的 TS 字面量，字段名 snake_case → camelCase。
 *
 * 用法：
 *   node scripts/rust-spec-to-ts.mjs <path-to-src-tauri> [out-file]
 *
 * 默认读取 Tauri 源项目（只读），输出到 src/main/models/spec-data.ts。
 */

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const SRC_ROOT = process.argv[2] ?? 'D:/app/ai/workspace/voxflow/src-tauri'
const OUT = process.argv[3] ?? 'src/main/models/spec-data.ts'

const specPath = join(SRC_ROOT, 'src/tts/spec.rs')
const raw = readFileSync(specPath, 'utf8')

// ── 1. 抽取 SPECS 数组体（按括号配对，跳过注释与字符串）──────────────────────
/** 匹配 Rust 字符字面量：'x' / '\n' / '\'' */
const CHAR_LITERAL = /^'(?:\\.|[^\\'])'/

function extractArray(text, marker) {
  const start = text.indexOf(marker)
  if (start < 0) throw new Error(`未找到标记: ${marker}`)
  // marker 形如 `pub static SPECS: &[ModelSpec] =` —— 需要跳过类型里的 `&[ModelSpec]`，
  // 真正要取的是 `= &[` 之后的那一层数组。
  const assign = text.indexOf('= &[', start)
  if (assign < 0) throw new Error(`未找到数组赋值: ${marker}`)
  const open = text.indexOf('[', assign)

  let depth = 0
  let inStr = false
  let escape = false
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (inStr) {
      if (ch === '\\') escape = true
      else if (ch === '"') inStr = false
      continue
    }
    // 行注释：整体跳过（注释里的引号 / 括号不参与配对）
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    // 字符字面量：整体跳过
    if (ch === "'") {
      const m = CHAR_LITERAL.exec(text.slice(i))
      if (m) {
        i += m[0].length - 1
        continue
      }
      // 非字面量的单引号（生命周期标记 &'static）—— 不改变任何状态
      continue
    }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  throw new Error('SPECS 数组未闭合')
}

// ── 2. 去掉 Rust 行注释（字符串感知，URL 里的 // 不能当注释）────────────────
function stripComments(text) {
  let out = ''
  let inStr = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      out += ch
      escape = false
      continue
    }
    if (inStr) {
      out += ch
      if (ch === '\\') escape = true
      else if (ch === '"') inStr = false
      continue
    }
    // 行注释：整体跳过
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      continue
    }
    // 字符字面量：整体保留
    if (ch === "'") {
      const m = CHAR_LITERAL.exec(text.slice(i))
      if (m) {
        out += m[0]
        i += m[0].length - 1
      }
      continue
    }
    out += ch
  }
  return out
}

let body = stripComments(extractArray(raw, 'pub static SPECS: &[ModelSpec] ='))
// 归一化行尾（Rust 源是 CRLF，项目约定 LF）
body = body.replace(/\r\n/g, '\n')

// ── 3. 语法转换（顺序敏感：具体模式在前）───────────────────────────────────
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())

const FIELD_MAP = {
  size_gb: 'sizeGb',
  description_zh: 'descriptionZh',
  description_en: 'descriptionEn',
  extra_files: 'extraFiles',
  label_zh: 'labelZh',
  label_en: 'labelEn',
  size_mb: 'sizeMb',
  dest_rel: 'destRel',
  speakers_file: 'speakersFile',
  per_language: 'perLanguage',
  requires_text: 'requiresText',
  overrides_preset: 'overridesPreset',
  required_files: 'requiredFiles',
  language_mode: 'languageMode',
  voice_mode: 'voiceMode'
}

const RUNTIME_KEYS = {
  SpeakerId: 'speakerId',
  Language: 'language',
  Provider: 'provider',
  NumThreads: 'numThreads',
  OutputPath: 'outputPath',
  ReferenceAudio: 'referenceAudio',
  ReferenceText: 'referenceText',
  MainModelFile: 'mainModelFile'
}

// VoiceMode::Preset(PresetSpec { ... })
body = body.replace(
  /VoiceMode::Preset\(\s*PresetSpec\s*\{([^}]*)\}\s*,?\s*\)/g,
  (_, inner) => {
    const fields = parseFields(inner)
    return `{ type: 'preset', count: ${fields.count}, speakersFile: ${fields.speakers_file ?? 'null'}, perLanguage: ${fields.per_language} }`
  }
)
// VoiceMode::Clone(CloneSpec { ... })
body = body.replace(/VoiceMode::Clone\(\s*CloneSpec\s*\{([^}]*)\}\s*,?\s*\)/g, (_, inner) => {
  const f = parseFields(inner)
  return `{ type: 'clone', requiresText: ${f.requires_text}, overridesPreset: ${f.overrides_preset} }`
})
// VoiceMode::PresetAndClone(PresetSpec {..}, CloneSpec {..})
body = body.replace(
  /VoiceMode::PresetAndClone\(\s*PresetSpec\s*\{([^}]*)\}\s*,\s*CloneSpec\s*\{([^}]*)\}\s*,?\s*\)/g,
  (_, p, c) => {
    const pf = parseFields(p)
    const cf = parseFields(c)
    return `{ type: 'presetAndClone', preset: { count: ${pf.count}, speakersFile: ${pf.speakers_file ?? 'null'}, perLanguage: ${pf.per_language} }, clone: { requiresText: ${cf.requires_text}, overridesPreset: ${cf.overrides_preset} } }`
  }
)
body = body.replace(/VoiceMode::Fixed/g, `{ type: 'fixed' }`)

// DownloadSource
body = body.replace(
  /DownloadSource::GithubRelease\(\s*("(?:[^"\\]|\\.)*")\s*,?\s*\)/g,
  `{ type: 'github', url: $1 }`
)
body = body.replace(
  /DownloadSource::HuggingFace\s*\{([^}]*)\}/g,
  (_, inner) => {
    const f = parseFields(inner)
    return `{ type: 'huggingface', repo: ${f.repo}, revision: ${f.revision} }`
  }
)

// FileRole
body = body.replace(/FileRole::Main/g, `'main'`)
body = body.replace(/FileRole::Mmproj/g, `'mmproj'`)
body = body.replace(/FileRole::Extra/g, `'extra'`)

// BackendSpec
body = body.replace(
  /BackendSpec::Llama\(\s*AsrBackendSpec::Llama\s*,?\s*\)/g,
  `{ type: 'llama' }`
)
body = body.replace(
  /BackendSpec::SherpaWs\(\s*AsrBackendSpec::SherpaWs\s*\{([^}]*)\}\s*,?\s*\)/g,
  (_, inner) => {
    const f = parseFields(inner)
    return `{ type: 'sherpaWs', flag: ${f.flag} }`
  }
)
body = body.replace(
  /BackendSpec::SherpaTts\(\s*SherpaTtsSpec\s*\{([^}]*)\}\s*,?\s*\)/g,
  (_, inner) => {
    const f = parseFields(inner)
    return `{ type: 'sherpaTts', cli: ${f.cli}, requiredFiles: ${f.required_files} }`
  }
)
body = body.replace(
  /BackendSpec::PyTorch\(\s*PyTorchSpec\s*\{([^}]*)\}\s*,?\s*\)/g,
  (_, inner) => {
    const f = parseFields(inner)
    return `{ type: 'pytorch', adapter: ${f.adapter}, language: ${f.language}, voice: ${f.voice} }`
  }
)

// ArgSpec
body = body.replace(
  /ArgSpec::Static\(\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*,?\s*\)/g,
  `{ type: 'static', flag: $1, value: $2 }`
)
body = body.replace(
  /ArgSpec::File\(\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*,?\s*\)/g,
  `{ type: 'file', flag: $1, value: $2 }`
)
body = body.replace(
  /ArgSpec::OptionalFile\(\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*,?\s*\)/g,
  `{ type: 'optionalFile', flag: $1, value: $2 }`
)
body = body.replace(
  /ArgSpec::ModelsRootFile\(\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*,?\s*\)/g,
  `{ type: 'modelsRootFile', flag: $1, value: $2 }`
)
body = body.replace(
  /ArgSpec::JoinableFiles\(\s*("(?:[^"\\]|\\.)*")\s*,\s*&\[([^\]]*)\]\s*,\s*'([^'\\]*)'\s*,?\s*\)/g,
  (_, flag, cands, sep) =>
    `{ type: 'joinableFiles', flag: ${flag}, candidates: [${cands}], sep: '${sep}' }`
)
body = body.replace(
  /ArgSpec::RuntimeVar\(\s*("(?:[^"\\]|\\.)*")\s*,\s*RuntimeKey::(\w+)\s*,?\s*\)/g,
  (_, flag, key) => `{ type: 'runtimeVar', flag: ${flag}, key: '${RUNTIME_KEYS[key]}' }`
)

// 结构体字面量 → 普通对象字面量
body = body.replace(/\bModelSpec\s*\{/g, '{')
body = body.replace(/\bDownloadEntry\s*\{/g, '{')
body = body.replace(/\bEntryFile\s*\{/g, '{')
body = body.replace(/\bExtraFile\s*\{/g, '{')

// ModelKind / LanguageMode
body = body.replace(/ModelKind::Asr/g, `'asr'`)
body = body.replace(/ModelKind::Tts/g, `'tts'`)
body = body.replace(/LanguageMode::(\w+)/g, (_, v) => `'${camel(v.toLowerCase())}'`)

// Option
body = body.replace(/Some\((\"(?:[^\"\\]|\\.)*\")\)/g, '$1')
body = body.replace(/\bNone\b/g, 'null')

// 引用切片
body = body.replace(/&\s*\[/g, '[')

// 字段名 snake → camel
body = body.replace(/(\b)([a-z0-9_]+)(\s*):/g, (m, p, key, sp) => {
  const mapped = FIELD_MAP[key]
  if (!mapped) return m
  return `${p}${mapped}${sp}:`
})

/** 按顶层逗号切分（括号 / 方括号 / 花括号 / 字符串内部不算） */
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let inStr = false
  let escape = false
  let cur = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      cur += ch
      escape = false
      continue
    }
    if (ch === '\\' && inStr) {
      cur += ch
      escape = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      cur += ch
      continue
    }
    if (!inStr) {
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') depth--
      else if (ch === ',' && depth === 0) {
        parts.push(cur.trim())
        cur = ''
        continue
      }
    }
    cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

/** 解析 Rust 结构体字面量的字段（顶层逗号切分，支持嵌套数组/元组值） */
function parseFields(inner) {
  const out = {}
  for (const part of splitTopLevel(inner)) {
    const idx = part.indexOf(':')
    if (idx < 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

// ── 4. 校验：不允许残留 Rust 语法 ───────────────────────────────────────────
if (process.env.SPEC_DEBUG) {
  writeFileSync(process.env.SPEC_DEBUG, body, 'utf8')
}
const leftovers = body.match(/\b(?:ModelKind|LanguageMode|VoiceMode|DownloadSource|FileRole|BackendSpec|ArgSpec|RuntimeKey|AsrBackendSpec|SherpaTtsSpec|PyTorchSpec|PresetSpec|CloneSpec|ModelSpec|DownloadEntry|EntryFile|ExtraFile)::/g)
if (leftovers) {
  throw new Error(`仍有未转换的 Rust 枚举引用: ${[...new Set(leftovers)].join(', ')}`)
}
if (/\bSome\(|\bNone\b|&\s*\[/.test(body)) {
  throw new Error('仍有未转换的 Option / 引用切片语法')
}

// ── 5. 输出 ────────────────────────────────────────────────────────────────
const header = `/**
 * 模型描述符数据表 —— 由 \`scripts/rust-spec-to-ts.mjs\` 从 Tauri 版
 * \`src-tauri/src/tts/spec.rs\` 的 \`SPECS\` 静态表自动转换而来（勿手工编辑）。
 *
 * 字段名已从 Rust 的 snake_case 归一为 camelCase；枚举判别值改为字符串字面量。
 */

export interface DownloadSourceSpec {
  type: 'github' | 'huggingface'
  url?: string
  repo?: string
  revision?: string
}

export interface EntryFileSpec {
  role: 'main' | 'mmproj' | 'extra'
  name: string
  sizeMb: number
}

export interface DownloadEntrySpec {
  id: string
  labelZh: string
  labelEn: string
  files: EntryFileSpec[]
  default: boolean
}

export interface ExtraFileSpec {
  source: DownloadSourceSpec
  destRel: string
}

export interface PresetSpec {
  count: number
  speakersFile: string | null
  perLanguage: boolean
}

export interface CloneSpec {
  requiresText: boolean
  overridesPreset: boolean
}

export type VoiceModeSpec =
  | { type: 'fixed' }
  | { type: 'preset'; count: number; speakersFile: string | null; perLanguage: boolean }
  | { type: 'clone'; requiresText: boolean; overridesPreset: boolean }
  | {
      type: 'presetAndClone'
      preset: PresetSpec
      clone: CloneSpec
    }

export type ArgSpec =
  | { type: 'static'; flag: string; value: string }
  | { type: 'file'; flag: string; value: string }
  | { type: 'optionalFile'; flag: string; value: string }
  | { type: 'modelsRootFile'; flag: string; value: string }
  | { type: 'joinableFiles'; flag: string; candidates: string[]; sep: string }
  | {
      type: 'runtimeVar'
      flag: string
      key:
        | 'speakerId'
        | 'language'
        | 'provider'
        | 'numThreads'
        | 'outputPath'
        | 'referenceAudio'
        | 'referenceText'
        | 'mainModelFile'
    }

export type BackendSpec =
  | { type: 'llama' }
  | { type: 'sherpaWs'; flag: string }
  | { type: 'sherpaTts'; cli: ArgSpec[]; requiredFiles: string[] }
  | { type: 'pytorch'; adapter: string; language: string; voice: string }

export interface ModelSpec {
  id: string
  name: string
  kind: 'asr' | 'tts'
  framework: string
  source: DownloadSourceSpec
  entries: DownloadEntrySpec[]
  sizeGb: number
  descriptionZh: string
  descriptionEn: string
  available: boolean
  cpu: string
  extraFiles: ExtraFileSpec[]
  quant: string | null
  languages: string[]
  languageMode: 'auto' | 'fixed' | 'select' | 'cloning'
  voiceMode: VoiceModeSpec
  backend: BackendSpec
}

export const SPECS: ModelSpec[] = [
`
writeFileSync(
  OUT,
  `${header}${body}\n]\n`,
  'utf8'
)

console.log(`已生成 ${OUT}（${body.split('\n').length} 行）`)
