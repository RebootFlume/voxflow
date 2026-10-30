/**
 * ASR 引擎存活诊断：加载后从外部（进程表 + 端口）独立观测引擎是否稳定存活。
 * 用法：node scripts/diag-asr-lifetime.mjs [port]
 */
import { WebSocket } from 'ws'
import { execFileSync } from 'node:child_process'

const port = process.argv[2] ?? '9222'

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
      .then(r => ({ ok: true, r })).catch(e => ({ ok: false, err: String(e && e.message || e) }))`
  )
}

/** 外部观测：llama-server 进程数 + 8931 端口监听数 */
function observe() {
  let procs = 0
  let listen = 0
  try {
    const out = execFileSync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process llama-server -ErrorAction SilentlyContinue).Count`
    ], { encoding: 'utf-8' }).trim()
    procs = Number(out) || 0
  } catch { /* ignore */ }
  try {
    const out = execFileSync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-NetTCPConnection -LocalPort 8931 -State Listen -ErrorAction SilentlyContinue).Count`
    ], { encoding: 'utf-8' }).trim()
    listen = Number(out) || 0
  } catch { /* ignore */ }
  return { procs, listen }
}

console.log('\n【ASR 引擎存活诊断】')

// 1. 卸载干净，从零加载
await call('rust_unload_asr')
await new Promise((r) => setTimeout(r, 1500))

console.log('  加载 Qwen3-ASR-0.6B（cpu）…')
const t0 = Date.now()
const load = await call('rust_load_asr', { model: 'Qwen3-ASR-0.6B', device: 'cpu' })
console.log(`    rust_load_asr 返回: ${JSON.stringify(load).slice(0, 200)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)

console.log('\n  观测 40 秒（外部进程/端口 + 应用内状态）：')
console.log('    t(s)  llama进程  8931监听  status.loaded  status.model')
for (let i = 0; i < 20; i++) {
  const obs = observe()
  const st = await call('rust_get_status')
  const s = st.ok ? st.r : {}
  const asr = s.asr ?? {}
  console.log(
    `    ${String(i * 2).padStart(4)}  ${String(obs.procs).padStart(9)}  ${String(obs.listen).padStart(9)}  ${String(asr.loaded).padStart(13)}  ${asr.model ?? '-'}`
  )
  await new Promise((r) => setTimeout(r, 2000))
}

console.log('\n  结束')
ws.close()
process.exit(0)
