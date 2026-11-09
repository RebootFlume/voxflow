#!/usr/bin/env node
/**
 * 一致性检查 —— 类型系统管不到的那类「约定」。
 *
 * 为什么需要它：能用类型表达的约束，编译器已经在管（见 framework-ids.ts 的两个断言、
 * EngineName 的徽章表）。剩下的问题是**跨文件、跨语言字面量的对齐**：
 *   - i18n 的 zh / en 两份字典键必须一一对应
 *   - 代码里 t(locale, "key") 用到的键必须真实存在
 *   - spec 的 framework 必须落在 MODEL_LAYERS 里、legacyDirs 不能撞车
 * 这些 tsc 都不看，漏了就表现为「界面上出现原始 key」或「某个旧目录迁移失败」。
 *
 * 用法：node scripts/check-consistency.mjs
 * 已挂进 `npm run typecheck`，改完代码跑一次类型检查即可。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

function fail(msg) {
  problems.push(msg)
}

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf-8')
}

/** 递归收集 src 下的 ts/tsx 文件 */
function walk(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name)
    const st = statSync(join(ROOT, rel))
    if (st.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel)
  }
  return out
}

// ── 1. i18n 键对齐 ────────────────────────────────────────────────────────
{
  const src = read('src/renderer/src/lib/i18n.ts')
  const zhAt = src.indexOf('  zh: {')
  const enAt = src.indexOf('  en: {')
  if (zhAt < 0 || enAt < 0) {
    fail('i18n.ts: 找不到 zh / en 字典块（检查脚本的解析假设已过期）')
  } else {
    const KEY = /^\s{4}"([^"]+)":/gm
    const collect = (text) => {
      const keys = new Set()
      for (const m of text.matchAll(KEY)) keys.add(m[1])
      return keys
    }
    const zh = collect(src.slice(zhAt, enAt))
    const en = collect(src.slice(enAt))
    for (const k of zh) if (!en.has(k)) fail(`i18n: en 缺少键 "${k}"`)
    for (const k of en) if (!zh.has(k)) fail(`i18n: zh 缺少键 "${k}"`)
    notes.push(`i18n: zh ${zh.size} 键 / en ${en.size} 键`)
  }
}

// ── 2. 代码里引用的 i18n 键都真实存在 ──────────────────────────────────────
{
  const src = read('src/renderer/src/lib/i18n.ts')
  const enAt = src.indexOf('  en: {')
  const all = new Set()
  for (const m of src.matchAll(/^\s{4}"([^"]+)":/gm)) all.add(m[1])

  const files = walk('src/renderer/src')
  /** t(locale, "key") / t(locale, "key", {...})；参数可以是 locale 变量或别的表达式 */
  const CALL = /\bt\(\s*[A-Za-z_$][\w$.]*\s*,\s*["']([^"']+)["']/g
  let refs = 0
  for (const f of files) {
    if (f.endsWith('i18n.ts')) continue
    const text = read(f)
    for (const m of text.matchAll(CALL)) {
      refs++
      if (!all.has(m[1])) {
        const line = text.slice(0, m.index).split('\n').length
        fail(`i18n: ${relative(ROOT, join(ROOT, f))}:${line} 引用了不存在的键 "${m[1]}"`)
      }
    }
  }
  notes.push(`i18n: 检查 ${refs} 处 t() 引用（en 字典 ${all.size} 键）`)
  void enAt
}

// ── 3. spec 一致性 ────────────────────────────────────────────────────────
{
  const idsSrc = read('src/main/models/framework-ids.ts')
  const layers = [...(idsSrc.match(/MODEL_LAYERS = \[([^\]]+)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
    (m) => m[1]
  )
  if (layers.length === 0) fail('framework-ids.ts: 解析 MODEL_LAYERS 失败')

  const specSrc = read('src/main/models/spec-data.ts')
  // 按顶层 `id: "..."` 切块（缩进 8 空格 = SPECS 数组元素）
  const marks = [...specSrc.matchAll(/^ {8}id: "([^"]+)"/gm)]
  if (marks.length === 0) fail('spec-data.ts: 解析不出任何 spec')

  const seenId = new Map()
  const seenDir = new Map()
  const seenLegacy = new Map()

  marks.forEach((m, i) => {
    const id = m[1]
    const end = i + 1 < marks.length ? marks[i + 1].index : specSrc.length
    const block = specSrc.slice(m.index, end)
    const line = specSrc.slice(0, m.index).split('\n').length

    const fw = block.match(/framework: "([^"]+)"/)?.[1]
    if (!fw) fail(`spec "${id}"（第 ${line} 行）没有 framework`)
    else if (!layers.includes(fw)) {
      fail(`spec "${id}" 的 framework "${fw}" 不在 MODEL_LAYERS [${layers.join(', ')}] 里`)
    }

    // 身份是复合键 `<层>/<目录名>`：同一个 id 可以出现在不同框架层
    // （Qwen3-ASR-0.6B 同时有 llama.cpp 与 audio.cpp 版），同层内重复才是错
    const key = `${fw}/${id}`
    if (seenId.has(key)) fail(`spec 重复: "${key}"（第 ${seenId.get(key)} 与 ${line} 行）`)
    else seenId.set(key, line)

    // 声明的下载文件必须是相对路径（absolute 会让所有平台都解错位置）
    for (const f of block.matchAll(/name: "([^"]+)"/g)) {
      if (/^[A-Za-z]:[\\/]/.test(f[1]) || f[1].startsWith('/')) {
        fail(`spec "${id}": 文件名 "${f[1]}" 是绝对路径`)
      }
    }

    // legacyDirs 会驱动目录搬迁：撞车 = 两个 spec 抢同一个旧目录
    const legacy = [...(block.match(/legacyDirs: \[([^\]]*)\]/)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(
      (x) => x[1]
    )
    for (const d of legacy) {
      if (seenDir.has(d)) fail(`legacyDir "${d}" 同时被 "${seenDir.get(d)}" 与 "${id}" 声明`)
      else seenDir.set(d, id)
      if (seenLegacy.has(d)) fail(`legacyDir "${d}" 在同一 spec 里重复`)
      seenLegacy.set(d, id)
    }
  })

  notes.push(`spec: ${marks.length} 条，framework 全部落在 ${layers.length} 个框架层内`)
}

// ── 4. 运行时包键与 targetDir ─────────────────────────────────────────────
{
  const pkgSrc = read('src/main/inference/runtime-packages.ts')
  const keys = [...pkgSrc.matchAll(/^ {4}framework: '([^']+)'/gm)].map((m) => m[1])
  const dirs = [...pkgSrc.matchAll(/^ {4}targetDir: '([^']+)'/gm)].map((m) => m[1])
  if (keys.length === 0) fail('runtime-packages.ts: 解析不出任何 package')
  if (new Set(keys).size !== keys.length) fail(`runtime-packages.ts: framework 键重复 [${keys.join(', ')}]`)
  if (new Set(dirs).size !== dirs.length) fail(`runtime-packages.ts: targetDir 重复 [${dirs.join(', ')}]`)

  const idsSrc = read('src/main/models/framework-ids.ts')
  const runtimeKeys = [
    ...(idsSrc.match(/RUNTIME_KEYS = \[([^\]]+)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)
  ].map((m) => m[1])
  for (const k of runtimeKeys) {
    if (!keys.includes(k)) fail(`RUNTIME_KEYS 里的 "${k}" 在 RUNTIME_PACKAGES 中没有数据行`)
  }
  notes.push(`runtime: ${keys.length} 个包 / ${dirs.join(', ')}`)
}

// ── 输出 ─────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  ${n}`)

if (problems.length > 0) {
  console.error(`\n✗ 一致性检查失败（${problems.length} 项）:`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('\n✓ 一致性检查通过')
