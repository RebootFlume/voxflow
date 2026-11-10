/**
 * TTS 层单元测试（阶段二移植验证）。
 *
 * 用 Vite 的 build API 把本文件打成临时 ESM 后用 node 执行 —— 项目没有装 tsx/esbuild，
 * 借用 vite 自身的打包能力最省事，也避免给运行时引入额外依赖。
 */

import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitText, MAX_CHARS_PER_CHUNK } from '../src/shared/tts-chunk'
import * as voices from '../src/main/tts/voices'
import { clampSeconds } from '../src/main/tts/reference-audio'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? undefined : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

// ── 1. 长文本切分 ───────────────────────────────────────────────────────────
console.log('\n【chunk.splitText】')
eq('短文本单段', splitText('你好，世界。', 120), ['你好，世界。'])
eq('去首尾空白', splitText('  padded  ', 120), ['padded'])
eq('空输入', splitText('', 120), [])
eq('纯空白', splitText('   \n\t ', 120), [])

const sentChunks = splitText('第一句话。第二句话。第三句话。', 6)
check('长文本切成多段', sentChunks.length > 1, JSON.stringify(sentChunks))
check('每段结束在句末标点', sentChunks.every((c) => c.endsWith('。')), JSON.stringify(sentChunks))

const commaText = '这是一个很长很长很长的句子，它只用逗号分隔，没有任何句末标点'
const commaChunks = splitText(commaText, 14)
check('退到句内标点切分', commaChunks.length > 1 && commaChunks[0].endsWith('，'), JSON.stringify(commaChunks))

const noPunct = 'a'.repeat(300)
const hardChunks = splitText(noPunct, 120)
eq('无标点硬切成 3 段', hardChunks.length, 3)
check('每段不超限', hardChunks.every((c) => [...c].length <= 120))
eq('硬切不丢字符', hardChunks.join(''), noPunct)

const messy = '第一句，带逗号。第二句有点长，还有别的标点！第三句没有句末标点，最后一句'
const messyChunks = splitText(messy, 12)
eq('切分不丢字符', messyChunks.join(''), messy)
check('每段不超限', messyChunks.every((c) => [...c].length <= 12))

const tiny = splitText('好。这一段后面还有很长的内容需要继续说下去，不能切碎。', 30)
check('避免切出碎段', [...tiny[0]].length >= Math.floor(30 / 3), JSON.stringify(tiny))
check('默认段长常量', MAX_CHARS_PER_CHUNK === 120)

// ── 2. 音色库 ───────────────────────────────────────────────────────────────
console.log('\n【voices 音色库】')
const dir = mkdtempSync(join(tmpdir(), 'voxflow-voices-'))

const draft = join(dir, 'ref-1.wav')
writeFileSync(draft, 'RIFFfake')
const v1 = voices.add(dir, draft, '  小明  ', ' 参考自录音 ', ' 你好世界 ')
eq('名称去空白', v1.name, '小明')
eq('说明去空白', v1.note, '参考自录音')
eq('参考文本去空白', v1.referenceText, '你好世界')
check('草稿被移走进库', existsSync(voices.pathOf(dir, v1)) && !existsSync(draft))
eq('索引落一条', voices.load(dir).voices.length, 1)

const outside = join(dir, '..', `user-voice-${Date.now()}.wav`)
writeFileSync(outside, 'user-audio-bytes')
const v2 = voices.add(dir, outside, '我的录音', '', '参考文本')
check('用户上传的原文件仍在原处', existsSync(outside))
eq('库内有副本', readFileSync(voices.pathOf(dir, v2), 'utf-8'), 'user-audio-bytes')
rmSync(outside, { force: true })

let threw = false
try {
  voices.add(dir, join(dir, 'ref-2.wav'), '   ', '', '')
} catch {
  threw = true
}
check('空名称被拒绝', threw)

const updated = voices.update(dir, v1.id, '新名', '备注', '新文本')
eq('改名生效', [updated.name, updated.note, updated.referenceText], ['新名', '备注', '新文本'])
eq('索引同步', voices.load(dir).voices[0].name, '新名')

voices.setActive(dir, v1.id)
eq('设为当前选中', voices.active(dir)?.id, v1.id)
voices.setActive(dir, v2.id)
eq('切换当前选中', voices.active(dir)?.id, v2.id)
voices.remove(dir, v2.id)
eq('删除后清空 active', voices.active(dir), null)
check('音频文件一并删除', !existsSync(voices.pathOf(dir, v2)))
eq('删除后剩一条', voices.load(dir).voices.length, 1)

voices.setActive(dir, v1.id)
voices.clearActive(dir)
eq('clearActive 取消选中', voices.active(dir), null)

// 孤儿清理
const orphan = join(dir, 'v-999999.wav')
writeFileSync(orphan, 'orphan')
voices.pruneOrphans(dir, voices.load(dir))
check('孤儿音频被清理', !existsSync(orphan))

rmSync(dir, { recursive: true, force: true })

// ── 4. 参考录音时长钳制 ─────────────────────────────────────────────────────
console.log('\n【reference-audio 时长钳制】')
eq('默认 6 秒', clampSeconds(6), 6)
eq('越下界收敛到 3', clampSeconds(0.5), 3)
eq('越上界收敛到 30', clampSeconds(600), 30)
eq('NaN → 默认', clampSeconds(Number.NaN), 6)
eq('0 → 默认', clampSeconds(0), 6)
eq('负数 → 默认', clampSeconds(-3), 6)

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
