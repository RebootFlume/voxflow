/**
 * 真实推理端到端验证（TTS → ASR 闭环）。
 *
 * 用真实模型 + 真实推理框架跑一遍完整链路：
 *   1. 运行时就绪（sherpa-onnx / llama-cpp）
 *   2. 模型清单显示已下载
 *   3. Kokoro TTS 合成中文语音 → WAV
 *   4. 校验 WAV 有真实音频（非静音）
 *   5. Qwen3-ASR（llama-server）转写这段 WAV → 文本
 *   6. 比对识别文本与原文
 *
 * 需要：本机已装 llama-cpp / sherpa-onnx 运行时 + 已下载对应模型。
 * 用法：node scripts/verify-real-inference.mjs [port]
 */
import { WebSocket } from 'ws'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const port = process.argv[2] ?? '9222'
const OUT_DIR = 'C:/Users/xiaoda/AppData/Local/Temp/opencode/voxflow-real'

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.error('未找到渲染进程 target')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const events = []
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

async function call(cmd, args = {}) {
  return evaluate(
    `window.voxflow.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})
      .then(r => ({ ok: true, r }))
      .catch(e => ({ ok: false, err: String(e && e.message || e) }))`
  )
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

// 开始收集事件
await evaluate(
  `window.voxflow.listen('sidecar://event', (p) => { window.__vfEvents = window.__vfEvents || []; window.__vfEvents.push(p) }).then(() => 1)`
)

async function waitFor(predicate, timeoutMs, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const got = await evaluate(
      `JSON.stringify((window.__vfEvents || []).filter(p => ${predicate}))`
    )
    const arr = JSON.parse(got || '[]')
    if (arr.length > 0) return arr
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`等待事件超时（${timeoutMs}ms）：${label}`)
}

async function clearEvents() {
  await evaluate('window.__vfEvents = []; 1')
}

console.log('\n【真实推理验证】')

// ── 1. 运行时 ──────────────────────────────────────────────────────────────
console.log('  … 检查推理框架')
const rt = await call('check_runtime')
const pkgs = rt.ok ? rt.r.packages : []
check('sherpa-onnx 运行时已安装', pkgs.some((p) => p.framework === 'onnx' && p.installed), JSON.stringify(pkgs.filter(p=>p.installed).map(p=>p.framework)))
check('llama-cpp 运行时已安装', pkgs.some((p) => p.framework === 'gguf' && p.installed), '')

// ── 2. 模型清单 ────────────────────────────────────────────────────────────
console.log('  … 检查模型清单')
await clearEvents()
await call('send_to_sidecar_safe', { payload: { action: 'list_models' } })
const stateEv = await waitFor(`p.status === 'models_state'`, 15000, 'models_state')
const models = stateEv[0].models
// 挑"已下载"的 Kokoro（本机装的是 v1_0；v1_1 也在清单里但没下载）
const kokoro = models.find((m) => m.kind === 'tts' && /Kokoro/.test(m.name) && m.state === 'downloaded')
const qwen = models.find((m) => /Qwen3-ASR-0.6B/.test(m.name) && m.kind === 'asr')
check('Kokoro TTS 模型已下载', !!kokoro, JSON.stringify(models.filter((m) => /Kokoro/.test(m.name)).map((m) => ({ name: m.name, state: m.state }))))
check('Qwen3-ASR-0.6B 模型已下载', qwen?.state === 'downloaded', JSON.stringify(qwen && { name: qwen.name, state: qwen.state }))

// ── 3. TTS 合成 ────────────────────────────────────────────────────────────
console.log('  … 加载 Kokoro TTS（sherpa-onnx）')
mkdirSync(OUT_DIR, { recursive: true })
await clearEvents()
// 前端走的是"模型展示名"（modelLoader.loadTtsModel(name, device)）
const loadTts = await call('rust_load_tts_model', { modelPath: kokoro?.name ?? 'Kokoro-v1_0', device: 'cpu' })
check('rust_load_tts_model 返回 loaded', loadTts.ok && loadTts.r.status === 'loaded', JSON.stringify(loadTts))
const ttsReady = await waitFor(
  `p.status === 'model_ready' && p.kind === 'tts'`,
  120000,
  'model_ready(tts)'
).catch((e) => {
  console.log('    ! ' + e.message)
  return []
})
check('收到 model_ready(tts) 事件', ttsReady.length > 0, JSON.stringify(ttsReady[0] ?? {}))

console.log('  … 合成中文语音（sid 45 = 晓北）')
const TEXT = '今天下午三点开会'
const syn = await call('rust_synthesize', { text: TEXT, voice: '45', exportDir: OUT_DIR })
check('rust_synthesize 成功', syn.ok && syn.r.saved_path, JSON.stringify(syn))
const wavPath = syn.ok ? syn.r.saved_path : ''
check('合成文件已落盘', wavPath && existsSync(wavPath), wavPath)

if (wavPath && existsSync(wavPath)) {
  const size = statSync(wavPath).size
  check('WAV 大小合理（> 100KB）', size > 100_000, `${size} bytes`)
  // 校验有真实音频：读 WAV 的 data 块，统计非零样本比例
  const buf = readFileSync(wavPath)
  let off = 12
  let dataStart = 0
  let dataLen = 0
  let rate = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const sz = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') rate = buf.readUInt32LE(off + 8 + 4)
    else if (id === 'data') {
      dataStart = off + 8
      dataLen = sz
      break
    }
    off += 8 + sz
  }
  let nonZero = 0
  let peak = 0
  const n = Math.floor(dataLen / 2)
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(dataStart + i * 2)
    if (v !== 0) nonZero++
    const a = Math.abs(v)
    if (a > peak) peak = a
  }
  const seconds = n / rate
  check('采样率合理（16k/22k/24k）', [16000, 22050, 24000].includes(rate), String(rate))
  check('音频时长合理（0.3~15s）', seconds > 0.3 && seconds < 15, `${seconds.toFixed(2)}s`)
  check('音频非静音（峰值 > 1000）', peak > 1000, `peak=${peak}`)
  check('非零样本占比 > 30%', nonZero / n > 0.3, `${((nonZero / n) * 100).toFixed(1)}%`)
  console.log(`    → ${wavPath}（${rate}Hz / ${seconds.toFixed(2)}s / peak=${peak}）`)
}

// ── 4. ASR 转写 ────────────────────────────────────────────────────────────
console.log('  … 加载 Qwen3-ASR-0.6B（llama-server，首次加载需读 1.1GB 权重）')
await clearEvents()
const loadAsr = await call('rust_load_asr', { model: 'Qwen3-ASR-0.6B', device: 'cuda' })
check('rust_load_asr 接受请求', loadAsr.ok && typeof loadAsr.r.reqId === 'number', JSON.stringify(loadAsr))
const asrReady = await waitFor(
  `p.status === 'model_ready' && p.kind === 'asr'`,
  300000,
  'model_ready(asr)'
).catch((e) => {
  console.log('    ! ' + e.message)
  return []
})
check('收到 model_ready(asr) 事件', asrReady.length > 0, JSON.stringify(asrReady[0] ?? {}))
if (asrReady.length === 0) {
  const errEv = await evaluate(`JSON.stringify((window.__vfEvents || []).filter(p => p.status === 'model_error'))`)
  console.log('    错误事件: ' + String(errEv).slice(0, 400))
}

if (wavPath && existsSync(wavPath) && asrReady.length > 0) {
  console.log('  … 转写合成出来的语音')
  const tr = await call('rust_transcribe_llama', { filePath: wavPath })
  check('rust_transcribe_llama 成功', tr.ok && typeof tr.r.text === 'string', JSON.stringify(tr).slice(0, 300))
  const got = tr.ok ? tr.r.text : ''
  console.log(`    原文: ${TEXT}`)
  console.log(`    识别: ${got}`)
  // 粗判：识别文本里至少包含原文的 3 个连续字，或有足够字重合
  const norm = (s) => s.replace(/[\s，。？！、,.?!]/g, '')
  const a = norm(TEXT)
  const b = norm(got)
  let best = 0
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 2; j <= a.length; j++) {
      if (b.includes(a.slice(i, j))) best = Math.max(best, j - i)
    }
  }
  check('识别文本与原文有实质重合（≥3 字连续）', best >= 3, `最长连续重合 ${best} 字`)
  check('识别文本非空', b.length > 0, got)
}

// ── 5. sherpa-onnx ASR 引擎（SenseVoice）────────────────────────────────────
console.log('  … 加载 SenseVoice（sherpa-onnx websocket server）')
await clearEvents()
const senseVoice = models.find((m) => /SenseVoice/.test(m.name) && m.kind === 'asr')
if (!senseVoice) {
  console.log('    ! 未安装 SenseVoice，跳过 sherpa ASR 验证')
} else {
  const loadSv = await call('rust_load_asr', { model: senseVoice.name, device: 'cpu' })
  check('rust_load_asr 接受 sherpa 模型', loadSv.ok, JSON.stringify(loadSv))
  const svReady = await waitFor(`p.status === 'model_ready' && p.kind === 'asr'`, 120000, 'model_ready(sherpa)').catch(
    (e) => {
      console.log('    ! ' + e.message)
      return []
    }
  )
  check('sherpa ASR 就绪', svReady.length > 0, JSON.stringify(svReady[0] ?? {}))

  if (svReady.length > 0 && wavPath && existsSync(wavPath)) {
    const trSv = await call('rust_transcribe_llama', { filePath: wavPath })
    check('sherpa 转写成功', trSv.ok && typeof trSv.r.text === 'string', JSON.stringify(trSv).slice(0, 300))
    const gotSv = trSv.ok ? trSv.r.text : ''
    console.log(`    sherpa 识别: ${gotSv}`)
    const normSv = (s) => s.replace(/[\s，。？！、,.?!]/g, '')
    const a2 = normSv(TEXT)
    const b2 = normSv(gotSv)
    let best2 = 0
    for (let i = 0; i < a2.length; i++) {
      for (let j = i + 2; j <= a2.length; j++) {
        if (b2.includes(a2.slice(i, j))) best2 = Math.max(best2, j - i)
      }
    }
    check('sherpa 识别文本与原文有实质重合（≥3 字连续）', best2 >= 3, `最长连续重合 ${best2} 字`)
  }
}

// ── 6. 对外 OpenAI 兼容 API（真实模型）──────────────────────────────────────
console.log('  … 通过对外 API 走一遍真实转写')
{
  const API_PORT = 19872
  const started = await call('send_to_sidecar_safe', {
    payload: { action: 'start_api', host: '127.0.0.1', port: API_PORT, api_key: '' }
  })
  check('start_api 成功', started.ok === true, JSON.stringify(started))
  await new Promise((r) => setTimeout(r, 800))

  if (wavPath && existsSync(wavPath)) {
    const form = new FormData()
    const bytes = readFileSync(wavPath)
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav')
    form.append('model', 'qwen3-asr')
    const res = await fetch(`http://127.0.0.1:${API_PORT}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form
    })
    check('API 转写返回 200', res.status === 200, `实际 ${res.status}`)
    const body = await res.json().catch(() => null)
    check('API 返回 { text }', typeof body?.text === 'string' && body.text.length > 0, JSON.stringify(body))
    if (body?.text) console.log(`    API 识别: ${body.text}`)
  }

  await call('send_to_sidecar_safe', { payload: { action: 'stop_api' } })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
ws.close()
process.exit(fail > 0 ? 1 : 0)
