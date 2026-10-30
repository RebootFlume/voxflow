/**
 * PyTorch 真机推理验证（阶段三-c 收尾 · 推理部分）。
 *
 * 走产品自身链路：
 *   1. download_model('Whisper-tiny-PT')  → 真实下载 HF 模型（145MB）
 *   2. rust_load_asr（pytorch 引擎）        → 真起 Python worker + torch 加载权重
 *   3. rust_transcribe_llama               → 真跑 transformers 的 Whisper 推理
 *   4. 与原文比对
 *
 * 依赖：pytorch-cpu 运行时已安装（先跑 verify-pytorch-runtime.mjs）
 * 用法：node scripts/verify-pytorch-inference.mjs [port]
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

async function waitFor(predicate, timeoutMs, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const got = await evaluate(`JSON.stringify((window.__vfEvents || []).filter(p => ${predicate}))`)
    const arr = JSON.parse(got || '[]')
    if (arr.length > 0) return arr
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`等待事件超时（${timeoutMs}ms）：${label}`)
}

console.log('\n【PyTorch 真机推理】')

// 0. 前置：PyTorch 运行时
const probe = await call('rust_pytorch_device_info', { device: 'cpu' })
check('PyTorch 运行时可用', probe.ok && probe.r.ok === true, JSON.stringify(probe).slice(0, 300))
if (!probe.ok || !probe.r.ok) {
  console.log('    先跑 npm run verify:pytorch-runtime 安装运行时')
  process.exit(1)
}
console.log(`    → python ${probe.r.info.python} / torch ${probe.r.info.torch}`)

// 1. 下载 whisper 模型（若已存在则跳过）
console.log('  … 检查/下载 Whisper-tiny-PT 模型')
await evaluate('window.__vfEvents = []; 1')
await call('send_to_sidecar_safe', { payload: { action: 'list_models' } })
const st = await waitFor(`p.status === 'models_state'`, 20000, 'models_state').catch(() => [])
const item = st[0]?.models?.find((m) => /Whisper-tiny-PT/.test(m.name))
check('模型清单含 Whisper-tiny-PT', !!item, JSON.stringify(item && { name: item.name, state: item.state }))

if (item?.state !== 'downloaded') {
  const dl = await call('send_to_sidecar_safe', {
    payload: { action: 'download_model', model: 'Whisper-tiny-PT' }
  })
  check('download_model 被接受', dl.ok === true, JSON.stringify(dl))
  const done = await waitFor(
    `p.status === 'model_downloaded' || p.status === 'model_download_error'`,
    15 * 60 * 1000,
    'model_downloaded'
  ).catch((e) => {
    console.log('    ! ' + e.message)
    return []
  })
  const err = done.find((e) => e.status === 'model_download_error')
  check('模型下载完成', done.some((e) => e.status === 'model_downloaded'), err ? JSON.stringify(err).slice(0, 300) : '')
  if (err) {
    console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
    ws.close()
    process.exit(1)
  }
} else {
  console.log('    模型已就绪，跳过下载')
}

// 2. 加载 PyTorch 引擎
console.log('  … 加载 PyTorch ASR 引擎（真起 Python worker + torch 加载权重）')
await evaluate('window.__vfEvents = []; 1')
const load = await call('rust_load_asr', { model: 'Whisper-tiny-PT', device: 'cpu' })
check('rust_load_asr 接受请求', load.ok === true, JSON.stringify(load))
const ready = await waitFor(
  `p.status === 'model_ready' && p.kind === 'asr'`,
  10 * 60 * 1000,
  'model_ready(pytorch)'
).catch((e) => {
  console.log('    ! ' + e.message)
  return []
})
check('PyTorch 引擎就绪', ready.length > 0, JSON.stringify(ready[0] ?? {}))
if (ready.length === 0) {
  const errs = await evaluate(`JSON.stringify((window.__vfEvents||[]).filter(p=>p.status==='model_error'))`)
  console.log('    错误: ' + String(errs).slice(0, 500))
}

// 3. 造一段测试音频：优先复用之前 sherpa 合成的中文语音
let wavPath = ''
mkdirSync(OUT_DIR, { recursive: true })
const existing = readdirSafe(OUT_DIR).filter((f) => f.endsWith('.wav')).sort()
if (existing.length > 0) wavPath = join(OUT_DIR, existing[existing.length - 1])
check('找到测试音频', !!wavPath, wavPath)

if (wavPath && ready.length > 0) {
  console.log('  … PyTorch 转写（transformers Whisper 真实推理）')
  const t0 = Date.now()
  const tr = await call('rust_transcribe_llama', { filePath: wavPath })
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  check('PyTorch 转写成功', tr.ok && typeof tr.r.text === 'string', JSON.stringify(tr).slice(0, 300))
  const got = tr.ok ? tr.r.text : ''
  console.log(`    识别: ${got}   (${dt}s)`)
  const norm = (s) => s.replace(/[\s，。？！、,.?!]/g, '')
  const a = norm('今天下午三点开会')
  const b = norm(got)
  let best = 0
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 2; j <= a.length; j++) if (b.includes(a.slice(i, j))) best = Math.max(best, j - i)
  }
  check('识别文本与原文有实质重合（≥3 字连续）', best >= 3, `最长连续重合 ${best} 字；识别="${got}"`)
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
ws.close()
process.exit(fail > 0 ? 1 : 0)

function readdirSafe(d) {
  try {
    return require('node:fs').readdirSync(d)
  } catch {
    return []
  }
}
