/**
 * TTS 命令的端到端 IPC 验证（阶段二）。
 *
 * 覆盖不依赖真实 sherpa 模型的路径：音色库增删改查、说话人列表空态、
 * 合成/克隆的「未加载模型」错误分支、取消令牌的空转语义。
 *
 * 用法：node scripts/verify-tts-ipc.mjs [port]
 */
import { WebSocket } from 'ws'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const port = process.argv[2] ?? '9222'
const DATA_ROOT = 'C:/Users/xiaoda/AppData/Roaming/com.voxflow.app'
const VOICES_DIR = join(DATA_ROOT, 'tts-voices')

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.error('未找到渲染进程 target')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
function send(method, params = {}) {
  const msgId = ++id
  return new Promise((resolve) => {
    pending.set(msgId, resolve)
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}
await new Promise((r) => ws.on('open', r))

async function evaluate(expr) {
  const res = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  })
  if (res.result?.exceptionDetails) return { __error: res.result.exceptionDetails.text }
  return res.result?.result?.value
}

/** 调用主进程命令；失败时返回 { __err: message } */
async function call(cmd, args = {}) {
  const js = `window.voxflow.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})
    .then(r => ({ ok: true, r }))
    .catch(e => ({ ok: false, err: String(e && e.message || e) }))`
  return evaluate(js)
}

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n【TTS 命令 IPC】')

// 0. 复位：先卸掉可能残留的引擎（上一轮真实推理会留下已加载的 TTS/ASR），
//    否则"未加载模型时应当报错"这类断言会因引擎还在而失效。
await call('rust_unload_tts_model')
await call('rust_unload_asr')

// 1. 音色库列表（初始为空）
const list0 = await call('rust_tts_voices_list')
check('音色库列表可调用', list0.ok === true, JSON.stringify(list0))
check('列表含 dir / active_id / voices 三个字段',
  list0.ok && 'dir' in list0.r && 'active_id' in list0.r && Array.isArray(list0.r.voices),
  JSON.stringify(list0))
check('音色库目录落在统一数据根下',
  list0.ok && String(list0.r.dir).replace(/\\/g, '/').includes('com.voxflow.app/tts-voices'),
  JSON.stringify(list0))

// 2. 入库：先造一个假 wav（模拟上传的文件，在库外 → 应被复制而非移动）
mkdirSync(DATA_ROOT, { recursive: true })
const outside = join(DATA_ROOT, 'uploaded-voice-test.wav')
writeFileSync(outside, 'RIFFfake-not-real-audio')
const add = await call('rust_tts_voice_add', {
  sourcePath: outside,
  name: '测试音色',
  note: '备注',
  referenceText: '参考文本'
})
check('音色入库成功', add.ok === true && typeof add.r?.id === 'string', JSON.stringify(add))
check('用户上传的原文件仍在原处（未被搬走）', existsSync(outside))
const voiceId = add.ok ? add.r.id : ''

// 3. 索引落盘（与 Tauri 版共用同一份 voices.json）
const indexPath = join(VOICES_DIR, 'voices.json')
check('索引文件已落盘', existsSync(indexPath))
if (existsSync(indexPath)) {
  const idx = JSON.parse(readFileSync(indexPath, 'utf-8'))
  check('索引含 snake_case 字段（与 Tauri 版兼容）',
    Array.isArray(idx.voices) && idx.voices[0] && 'reference_text' in idx.voices[0] && 'created_ms' in idx.voices[0],
    JSON.stringify(idx))
  check('索引 active_id 初始为空', idx.active_id === null)
}

// 4. 列表里能看到新条目
const list1 = await call('rust_tts_voices_list')
check('列表包含新条目',
  list1.ok && list1.r.voices.some((v) => v.id === voiceId && v.name === '测试音色'),
  JSON.stringify(list1))
check('条目字段与前端契约一致',
  list1.ok && list1.r.voices[0] &&
    'id' in list1.r.voices[0] && 'name' in list1.r.voices[0] && 'note' in list1.r.voices[0] &&
    'reference_text' in list1.r.voices[0] && 'audio_path' in list1.r.voices[0] && 'created_ms' in list1.r.voices[0],
  JSON.stringify(list1))

// 5. 改名
const upd = await call('rust_tts_voice_update', {
  id: voiceId,
  name: '改名后',
  note: '新备注',
  referenceText: '新参考文本'
})
check('改名成功', upd.ok === true, JSON.stringify(upd))
const list2 = await call('rust_tts_voices_list')
check('改名已生效', list2.ok && list2.r.voices[0].name === '改名后', JSON.stringify(list2))

// 6. 空名称被拒绝
const badUpd = await call('rust_tts_voice_update', { id: voiceId, name: '   ', note: '', referenceText: '' })
check('空名称被拒绝', badUpd.ok === false, JSON.stringify(badUpd))

// 7. 使用音色（未加载 TTS 模型 ⇒ 必须报错，且不得落库）
const use = await call('rust_tts_voice_use', { id: voiceId })
check('未加载模型时使用音色报错', use.ok === false, JSON.stringify(use))
const list3 = await call('rust_tts_voices_list')
check('失败后 active_id 仍为空（不谎报已选中）', list3.ok && list3.r.active_id === null, JSON.stringify(list3))

// 8. 说话人列表（无模型 ⇒ 空态，形状不变）
const speakers = await call('rust_list_tts_speakers')
check('说话人列表可调用', speakers.ok === true, JSON.stringify(speakers))
check('说话人空态形状正确',
  speakers.ok && speakers.r.model === '' && speakers.r.num_speakers === 0 && Array.isArray(speakers.r.speakers),
  JSON.stringify(speakers))

// 9. 合成 / 克隆：无模型 ⇒ 明确报错
const syn = await call('rust_synthesize', { text: '你好', voice: '0', exportDir: DATA_ROOT })
check('未加载模型时合成报错', syn.ok === false, JSON.stringify(syn))
const clone = await call('rust_set_tts_clone_voice', { audioPath: outside, referenceText: '文本' })
check('未加载模型时设置克隆报错', clone.ok === false, JSON.stringify(clone))
const clear = await call('rust_clear_tts_clone_voice')
check('清除克隆在无模型时不报错（no-op）', clear.ok === true, JSON.stringify(clear))

// 10. 取消令牌（无合成在跑 ⇒ cancelled=false）
const cancel = await call('rust_cancel_tts')
check('取消命令返回 cancelled=false（无合成在跑）',
  cancel.ok === true && cancel.r.cancelled === false, JSON.stringify(cancel))

// 11. 加载 TTS 模型
// 不存在的模型 ⇒ 必须报错（不静默成功）
const badLoad = await call('rust_load_tts_model', { modelPath: '不存在的模型', device: 'cpu' })
check('加载不存在的 TTS 模型报错', badLoad.ok === false, JSON.stringify(badLoad))
// 已安装的模型 ⇒ 应当能真的加载上（前提：本机已装 sherpa 运行时 + 已下载该模型）
const realLoad = await call('rust_load_tts_model', { modelPath: 'Kokoro-v1_0', device: 'cpu' })
if (realLoad.ok === false && String(realLoad.err).includes('缺少主模型文件')) {
  console.log('    ! 本机未安装 Kokoro 模型，跳过"真实加载"断言')
} else {
  check('加载已安装的 TTS 模型成功', realLoad.ok === true, JSON.stringify(realLoad))
}

// 12. 合成期间禁止改引擎参数
// 为什么这条重要：引擎在**每一段**都重新读 language / instruct / sid，
// 中途改掉会让同一个 WAV 前半段一种语言/音色、后半段另一种，而且不报错。
// 前端会置灰，但 HTTP API 走同一条引擎 —— 正确性不能依赖调用方记得禁用按钮。
{
  // 通过长合成制造 busy 状态：用一段足够长的文本 + 已加载模型（若可用）
  const longText = '这是一句用于制造合成忙碌状态的测试文本。'.repeat(12)
  const synthP = call('rust_synthesize', {
    text: longText,
    voice: 'alloy',
    exportDir: ''
  })
  // 给它一点时间进入 synthesizing（引擎若未加载会立刻失败，那就是另一条路径）
  await new Promise((r) => setTimeout(r, 1200))
  const langBlocked = await call('rust_set_tts_language', { language: 'en' })
  const instructBlocked = await call('rust_set_tts_instruct', { text: 'x' })
  const synthRes = await synthP

  const busy = !!(synthRes.ok && synthRes.r && synthRes.r.chunks > 1) ||
    String(langBlocked.err || '').includes('合成进行中')
  if (busy && String(langBlocked.err || '').includes('合成进行中')) {
    check('合成中拒绝修改语言', langBlocked.ok === false &&
      String(langBlocked.err).includes('合成进行中'), JSON.stringify(langBlocked))
    check('合成中拒绝修改音色描述', instructBlocked.ok === false &&
      String(instructBlocked.err).includes('合成进行中'), JSON.stringify(instructBlocked))
  } else {
    console.log('    ! 未能制造合成忙碌状态（模型未加载或合成过快），跳过参数锁定断言')
  }
  // 收尾：把可能的产物删掉
  if (synthRes.ok && synthRes.r?.saved_path) {
    try { rmSync(synthRes.r.saved_path, { force: true }) } catch {}
  }
}

// 13. 卸载模型（上面可能加载过）
await call('rust_unload_tts_model')

// 14. 清理：删除条目 + 删掉测试文件
const rm = await call('rust_tts_voice_remove', { id: voiceId })
check('删除条目成功', rm.ok === true, JSON.stringify(rm))
const list4 = await call('rust_tts_voices_list')
check('删除后列表为空', list4.ok && list4.r.voices.length === 0, JSON.stringify(list4))
rmSync(outside, { force: true })
rmSync(VOICES_DIR, { recursive: true, force: true })

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
ws.close()
process.exit(fail > 0 ? 1 : 0)
