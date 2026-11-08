#!/usr/bin/env node
/**
 * 轻量版本检查：只查「官方最新版本号是什么，我们 pin 的是哪个」，不下载、不改代码。
 *
 * 用法：
 *   node scripts/check-runtime-updates.mjs
 *
 * 退出码：0 = 全部最新（或成功查到）；1 = 查询失败。
 *
 * 查到落后之后怎么办：看 docs/upgrade-runtime.md，先跑
 *   node scripts/check-runtime-abi.mjs <framework> <新版本>
 * 确认结构体差异，再动手。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeSource = readFileSync(join(ROOT, 'src/main/inference/runtime-download.ts'), 'utf-8')

function pinnedVersion(framework) {
  const at = runtimeSource.indexOf(`framework: '${framework}'`)
  if (at < 0) return null
  const window = runtimeSource.slice(at, at + 2000)
  const m = window.match(/version: '([^']+)'/)
  return m ? m[1] : null
}

async function ghJson(url) {
  const resp = await fetch(url, {
    headers: { 'user-agent': 'voxflow-update-check', accept: 'application/vnd.github+json' }
  })
  if (!resp.ok) throw new Error(`GitHub ${resp.status} ${url}`)
  return resp.json()
}

/** llama.cpp 的二进制版本是 b#### 形式，semver release 里只有 nightly-tag.txt */
async function latestLlama() {
  const releases = await ghJson('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15')
  const build = releases.find((r) => /^b\d+$/.test(r.tag_name))
  return build ? build.tag_name : null
}

async function latestTag(repo) {
  const r = await ghJson(`https://api.github.com/repos/${repo}/releases/latest`)
  return r.tag_name
}

function compareBuild(pinned, latest) {
  const a = Number(String(pinned).replace(/\D/g, ''))
  const b = Number(String(latest).replace(/\D/g, ''))
  return { newer: b > a, behind: b - a, kind: 'build' }
}

function parseSemver(v) {
  const m = String(v).match(/^v?(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function compareSemver(pinned, latest) {
  const a = parseSemver(pinned)
  const b = parseSemver(latest)
  if (!a || !b) return null
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return { newer: true, behind: b[i] - a[i], kind: 'semver' }
    if (b[i] < a[i]) return { newer: false, behind: 0, kind: 'semver' }
  }
  return { newer: false, behind: 0, kind: 'semver' }
}

const TARGETS = [
  { id: 'gguf', label: 'llama.cpp', fetch: latestLlama, compare: compareBuild },
  {
    id: 'onnx',
    label: 'sherpa-onnx',
    fetch: () => latestTag('k2-fsa/sherpa-onnx'),
    compare: compareSemver
  },
  {
    id: 'audiocpp',
    label: 'audio.cpp',
    fetch: () => latestTag('0xShug0/audio.cpp'),
    compare: compareSemver
  }
]

let failed = false
const rows = []

for (const t of TARGETS) {
  const pinned = pinnedVersion(t.id)
  try {
    const latest = await t.fetch()
    const cmp = latest ? t.compare(pinned, latest) : null
    rows.push({
      label: t.label,
      pinned,
      latest: latest ?? '(未找到)',
      state: !latest || !cmp ? '?' : cmp.newer ? `落后（${cmp.behind}）` : '最新'
    })
  } catch (e) {
    failed = true
    rows.push({
      label: t.label,
      pinned,
      latest: '查询失败',
      state: e instanceof Error ? e.message : String(e)
    })
  }
}

const w = (s) => String(s ?? '')
const width = (key) => Math.max(8, ...rows.map((r) => w(r[key]).length))
const c1 = width('label')
const c2 = width('pinned')
const c3 = width('latest')
console.log(`\n${'框架'.padEnd(c1)}  ${'当前 pin'.padEnd(c2)}  ${'官方最新'.padEnd(c3)}  状态`)
console.log('-'.repeat(c1 + c2 + c3 + 12))
for (const r of rows) {
  console.log(`${w(r.label).padEnd(c1)}  ${w(r.pinned).padEnd(c2)}  ${w(r.latest).padEnd(c3)}  ${r.state}`)
}
console.log('')

const behind = rows.filter((r) => r.state.startsWith('落后'))
if (behind.length) {
  console.log(`有 ${behind.length} 个框架可升级。升级前先看 docs/upgrade-runtime.md，并跑：`)
  for (const r of behind) console.log(`  node scripts/check-runtime-abi.mjs <framework> ${r.latest}`)
} else if (!failed) {
  console.log('✅ 三个框架都是最新版本')
}
process.exitCode = failed ? 1 : 0
