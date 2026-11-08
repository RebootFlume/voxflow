#!/usr/bin/env node
/**
 * 运行时 ABI 校验：把官方头文件里的 C 结构体字段，与我们手写的 koffi 绑定逐字段比对。
 *
 * 为什么需要：koffi 绑定是「按某个具体版本手抄的 ABI」。C 侧结构体增删字段、调整顺序时，
 * 绑定层不会报错，而是静默读错位（字段值全错但程序不崩）。只有头文件 diff 能提前发现。
 *
 * 用法：
 *   node scripts/check-runtime-abi.mjs            # 校验三个框架（用当前 pin 的版本）
 *   node scripts/check-runtime-abi.mjs gguf       # 只校验 llama.cpp
 *   node scripts/check-runtime-abi.mjs gguf b12300  # 校验指定版本（升级前预演）
 *   node scripts/check-runtime-abi.mjs --offline  # 只用本地缓存的头文件
 *
 * 退出码：0 = 无差异；1 = 有差异（会列出「必须补 / 必须删 / 顺序不对」）。
 *
 * 注意：这里只比对**字段名与顺序**，不比对类型（C 的类型系统与 koffi 声明不是一一对应，
 * 强比对会误报）。类型是否兼容仍需人看头文件——脚本负责把范围缩小到具体几个字段。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = join(ROOT, '.cache', 'abi')

/** 各框架：绑定文件、头文件来源、koffi 结构体名 ↔ C 结构体名 */
const FRAMEWORKS = {
  gguf: {
    label: 'llama.cpp',
    bindings: 'src/main/inference/llama-ffi/bindings.ts',
    packageFramework: 'gguf',
    headers: (v) => [
      {
        file: 'llama.h',
        url: `https://raw.githubusercontent.com/ggml-org/llama.cpp/${v}/include/llama.h`
      },
      {
        file: 'mtmd.h',
        url: `https://raw.githubusercontent.com/ggml-org/llama.cpp/${v}/tools/mtmd/mtmd.h`
      },
      {
        file: 'mtmd-helper.h',
        url: `https://raw.githubusercontent.com/ggml-org/llama.cpp/${v}/tools/mtmd/mtmd-helper.h`
      }
    ],
    // llama 绑定的 koffi 结构体名与 C 结构体名一致（llama_model_params 等）
    structs: {
      llama_model_params: 'llama_model_params',
      llama_context_params: 'llama_context_params',
      llama_batch: 'llama_batch',
      llama_sampler_chain_params: 'llama_sampler_chain_params',
      mtmd_context_params: 'mtmd_context_params',
      mtmd_input_text: 'mtmd_input_text',
      mtmd_caps: 'mtmd_caps',
      mtmd_helper_bitmap_wrapper: 'mtmd_helper_bitmap_wrapper'
    }
  },
  onnx: {
    label: 'sherpa-onnx',
    bindings: 'src/main/inference/sherpa-ffi/bindings.ts',
    packageFramework: 'onnx',
    headers: (v) => [
      {
        file: 'c-api.h',
        url: `https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/${v}/sherpa-onnx/c-api/c-api.h`
      }
    ],
    structs: {
      SherpaOnnxFeatureConfig: 'SherpaFeatureConfig',
      SherpaOnnxOfflineNemoEncDecCtcModelConfig: 'SherpaOneModelConfig',
      SherpaOnnxOfflineTransducerModelConfig: 'SherpaTransducerConfig',
      SherpaOnnxOfflineWhisperModelConfig: 'SherpaWhisperConfig',
      SherpaOnnxOfflineSenseVoiceModelConfig: 'SherpaSenseVoiceConfig',
      SherpaOnnxOfflineMoonshineModelConfig: 'SherpaMoonshineConfig',
      SherpaOnnxOfflineFireRedAsrModelConfig: 'SherpaFireRedConfig',
      SherpaOnnxOfflineCanaryModelConfig: 'SherpaCanaryConfig',
      SherpaOnnxOfflineQwen3ASRModelConfig: 'SherpaQwen3AsrConfig',
      SherpaOnnxOfflineCohereTranscribeModelConfig: 'SherpaCohereConfig',
      SherpaOnnxOfflineModelConfig: 'SherpaModelConfig',
      SherpaOnnxOfflineLMConfig: 'SherpaLmConfig',
      SherpaOnnxHomophoneReplacerConfig: 'SherpaHomophoneReplacerConfig',
      SherpaOnnxOfflineCtcFstDecoderConfig: 'SherpaCtcFstDecoderConfig',
      SherpaOnnxOfflineRecognizerConfig: 'SherpaRecognizerConfig',
      SherpaOnnxOfflineTtsVitsModelConfig: 'SherpaVitsConfig',
      SherpaOnnxOfflineTtsMatchaModelConfig: 'SherpaMatchaConfig',
      SherpaOnnxOfflineTtsKokoroModelConfig: 'SherpaKokoroConfig',
      SherpaOnnxOfflineTtsKittenModelConfig: 'SherpaKittenConfig',
      SherpaOnnxOfflineTtsZipvoiceModelConfig: 'SherpaZipvoiceConfig',
      SherpaOnnxOfflineTtsPocketModelConfig: 'SherpaPocketConfig',
      SherpaOnnxOfflineTtsSupertonicModelConfig: 'SherpaSupertonicConfig',
      SherpaOnnxOfflineTtsModelConfig: 'SherpaTtsModelConfig',
      SherpaOnnxOfflineTtsConfig: 'SherpaTtsConfig',
      SherpaOnnxGeneratedAudio: 'SherpaGeneratedAudio',
      SherpaOnnxGenerationConfig: 'SherpaGenerationConfig'
    }
  },
  audiocpp: {
    label: 'audio.cpp',
    bindings: 'src/main/inference/audiocpp-ffi/bindings.ts',
    packageFramework: 'audiocpp',
    headers: (v) => [
      {
        file: 'audiocpp.h',
        url: `https://raw.githubusercontent.com/0xShug0/audio.cpp/${v}/include/audiocpp.h`
      }
    ],
    structs: {
      audiocpp_model_config: 'AudiocppModelConfig',
      audiocpp_backend_config: 'AudiocppBackendConfig'
    }
  }
}

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const offline = argv.includes('--offline')
const positional = argv.filter((a) => !a.startsWith('--'))
const only = positional[0] && positional[0] !== 'all' ? positional[0] : null
const versionOverride = positional[1] ?? null

if (only && !FRAMEWORKS[only]) {
  console.error(`未知框架: ${only}（可选 ${Object.keys(FRAMEWORKS).join(' / ')}）`)
  process.exit(2)
}

// ── 从 runtime-download.ts 读当前 pin 的版本 ────────────────────────────
const runtimeSource = readFileSync(join(ROOT, 'src/main/inference/runtime-download.ts'), 'utf-8')
function pinnedVersion(framework) {
  const at = runtimeSource.indexOf(`framework: '${framework}'`)
  if (at < 0) return null
  const window = runtimeSource.slice(at, at + 2000)
  const m = window.match(/version: '([^']+)'/)
  return m ? m[1] : null
}

// ── 解析绑定层的 koffi.struct 声明 ──────────────────────────────────────
/** 返回 Map<koffi 结构体名, 字段名数组> */
function parseBindings(path) {
  const src = readFileSync(path, 'utf-8')
  const out = new Map()
  const re = /koffi\.struct\(\s*'([^']+)'\s*,\s*\{/g
  let m
  while ((m = re.exec(src))) {
    const name = m[1]
    // 从 `{` 之后开始，做花括号配对，取结构体体内容
    let i = re.lastIndex - 1
    let depth = 0
    let body = ''
    for (; i < src.length; i++) {
      const ch = src[i]
      if (ch === '{') {
        depth++
        if (depth === 1) continue
      } else if (ch === '}') {
        depth--
        if (depth === 0) break
      }
      if (depth >= 1) body += ch
    }
    // 结构体体里一个字段可能横跨多行，也可能一行写多个字段——按顶层逗号切分
    const clean = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const fields = []
    let depth2 = 0
    let seg = ''
    for (const ch of clean) {
      if (ch === '{' || ch === '(' || ch === '[') depth2++
      else if (ch === '}' || ch === ')' || ch === ']') depth2--
      if (ch === ',' && depth2 === 0) {
        const fm = seg.match(/^\s*([A-Za-z_]\w*)\s*:/)
        if (fm) fields.push(fm[1])
        seg = ''
      } else {
        seg += ch
      }
    }
    const tail = seg.match(/^\s*([A-Za-z_]\w*)\s*:/)
    if (tail) fields.push(tail[1])
    out.set(name, fields)
  }
  return out
}

// ── 解析 C 头文件里的结构体 ────────────────────────────────────────────
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** 从一条 C 声明里取字段名（处理指针、数组、函数指针） */
function cFieldName(decl) {
  const d = decl.trim().replace(/\s+/g, ' ')
  if (!d) return null
  // 函数指针：void (*name)(...)
  const fn = d.match(/\(\s*\*\s*([A-Za-z_]\w*)\s*\)/)
  if (fn) return fn[1]
  // 数组：type name[SIZE]
  const arr = d.match(/([A-Za-z_]\w*)\s*\[[^\]]*\]\s*$/)
  if (arr) return arr[1]
  // 普通：type name
  const plain = d.match(/([A-Za-z_]\w*)\s*$/)
  if (plain) return plain[1]
  return null
}

/** 返回 Map<结构体名, 字段名数组> */
function parseHeaderStructs(src) {
  const text = stripComments(src).replace(/^[ \t]*#[^\n]*/gm, '')
  const out = new Map()

  // 1) struct Name { ... };
  const reNamed = /\bstruct\s+([A-Za-z_]\w*)\s*\{/g
  let m
  while ((m = reNamed.exec(text))) {
    const name = m[1]
    const body = readBraceBlock(text, m.index + m[0].length - 1)
    if (body === null) continue
    out.set(name, parseCBody(body))
    // 跳过已解析区域，避免把内层匿名结构体当顶层
    reNamed.lastIndex = m.index + m[0].length + body.length
  }

  // 2) typedef struct { ... } Name;  与  typedef struct X { ... } Name;
  const reTypedef = /typedef\s+struct\s+[A-Za-z_]*\w*\s*\{/g
  while ((m = reTypedef.exec(text))) {
    const body = readBraceBlock(text, m.index + m[0].length - 1)
    if (body === null) continue
    const after = text.slice(m.index + m[0].length + body.length + 1, m.index + m[0].length + body.length + 120)
    const alias = after.match(/^\s*([A-Za-z_]\w*)\s*;/)
    if (alias) out.set(alias[1], parseCBody(body))
    reTypedef.lastIndex = m.index + m[0].length + body.length
  }
  return out
}

function readBraceBlock(text, braceIndex) {
  let depth = 0
  let start = -1
  for (let i = braceIndex; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      depth++
      if (depth === 1) start = i + 1
    } else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i)
    }
  }
  return null
}

function parseCBody(body) {
  // 顶层按 ';' 切分（忽略嵌套花括号里的内容，例如匿名 union）
  const decls = []
  let depth = 0
  let buf = ''
  for (const ch of body) {
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (ch === ';' && depth === 0) {
      decls.push(buf)
      buf = ''
    } else {
      buf += ch
    }
  }
  const fields = []
  for (const d of decls) {
    if (!d.trim()) continue
    const name = cFieldName(d)
    if (name) fields.push(name)
  }
  return fields
}

// ── 差异比较 ────────────────────────────────────────────────────────────
/**
 * @returns {{missing: string[], extra: string[], order: string|null}}
 */
function diffFields(cFields, tsFields) {
  const cSet = new Set(cFields)
  const tsSet = new Set(tsFields)
  const missing = cFields.filter((f) => !tsSet.has(f))
  const extra = tsFields.filter((f) => !cSet.has(f))

  let order = null
  if (missing.length === 0 && extra.length === 0) {
    for (let i = 0; i < cFields.length; i++) {
      if (cFields[i] !== tsFields[i]) {
        order = `第 ${i + 1} 个字段起顺序不同：C 是 '${cFields[i]}'，绑定是 '${tsFields[i]}'`
        break
      }
    }
  }
  return { missing, extra, order }
}

// ── 下载 / 缓存头文件 ───────────────────────────────────────────────────
async function fetchHeader(url, cachePath) {
  if (existsSync(cachePath)) return readFileSync(cachePath, 'utf-8')
  if (offline) throw new Error(`缺少缓存且处于 --offline：${cachePath}`)
  const resp = await fetch(url, { headers: { 'user-agent': 'voxflow-abi-check' } })
  if (!resp.ok) throw new Error(`下载失败 ${resp.status} ${url}`)
  const text = await resp.text()
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, text, 'utf-8')
  return text
}

// ── 主流程 ──────────────────────────────────────────────────────────────
async function check(frameworkId) {
  const fw = FRAMEWORKS[frameworkId]
  const version = versionOverride ?? pinnedVersion(fw.packageFramework)
  if (!version) throw new Error(`无法从 runtime-download.ts 读到 ${fw.packageFramework} 的版本`)

  console.log(`\n=== ${fw.label}（${version}）===`)

  const bindingPath = join(ROOT, fw.bindings)
  const declarations = parseBindings(bindingPath)

  const headerStructs = new Map()
  for (const h of fw.headers(version)) {
    const cachePath = join(CACHE_DIR, `${fw.packageFramework}-${version}`, h.file)
    const text = await fetchHeader(h.url, cachePath)
    for (const [name, fields] of parseHeaderStructs(text)) {
      if (!headerStructs.has(name)) headerStructs.set(name, fields)
    }
  }

  let problems = 0
  for (const [cName, tsName] of Object.entries(fw.structs)) {
    const cFields = headerStructs.get(cName)
    const tsFields = declarations.get(tsName)
    if (!cFields) {
      console.log(`  ⚠️  头文件里找不到 struct ${cName}（可能被重命名/移除了）`)
      problems++
      continue
    }
    if (!tsFields) {
      console.log(`  ⚠️  绑定层里找不到 koffi.struct('${tsName}')`)
      problems++
      continue
    }
    const d = diffFields(cFields, tsFields)
    if (d.missing.length === 0 && d.extra.length === 0 && !d.order) {
      console.log(`  ✅ ${cName}  (${cFields.length} 字段)`)
      continue
    }
    problems++
    console.log(`  ❌ ${cName} ↔ ${tsName}`)
    if (d.missing.length) {
      console.log(`     需要新增（C 有、绑定没有）：${d.missing.join(', ')}`)
      // 给出建议：位置按 C 侧顺序定位到前后邻居
      for (const field of d.missing) {
        const idx = cFields.indexOf(field)
        const before = [...cFields.slice(0, idx)].reverse().find((f) => tsFields.includes(f))
        const after = cFields.slice(idx + 1).find((f) => tsFields.includes(f))
        const at = before ? `插在 '${before}' 之后` : after ? `插在 '${after}' 之前` : '位置无法确定'
        console.log(`       - ${field}（${at}）`)
      }
    }
    if (d.extra.length) {
      console.log(`     需要删除/改名（绑定有、C 没有）：${d.extra.join(', ')}`)
    }
    if (d.order) console.log(`     顺序问题：${d.order}`)
  }
  return problems
}

const targets = only ? [only] : Object.keys(FRAMEWORKS)
let total = 0
for (const t of targets) {
  try {
    total += await check(t)
  } catch (e) {
    console.error(`  ✖ ${t}: ${e instanceof Error ? e.message : String(e)}`)
    total++
  }
}

console.log('')
if (total === 0) {
  console.log('✅ 全部结构体与官方头文件一致')
  process.exitCode = 0
} else {
  console.log(`❌ 共 ${total} 处结构体差异，需要更新绑定层（改完请跑 typecheck + 真机冒烟）`)
  process.exitCode = 1
}
// 不用 process.exit()：Node 24 + undici 的 keep-alive socket 在 Windows 上会触发 libuv 断言崩溃
