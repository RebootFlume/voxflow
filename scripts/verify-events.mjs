/**
 * 端到端 IPC 事件总线验证：注册 sidecar 事件监听 → 触发 list_models →
 * 校验 models_state 事件载荷结构与 Tauri 版一致。
 * 用法：node scripts/verify-events.mjs [port]
 */
import { WebSocket } from 'ws'

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
  if (res.result?.exceptionDetails) {
    return { error: res.result.exceptionDetails.text, detail: res.result.exceptionDetails }
  }
  return res.result?.result?.value
}

const out = await evaluate(`(async () => {
  const received = []
  const un = await window.voxflow.listen('sidecar://event', (p) => received.push(p))
  await window.voxflow.invoke('send_to_sidecar_safe', { payload: { action: 'list_models' } })
  await new Promise((r) => setTimeout(r, 1200))
  const asr = await window.voxflow.listen('asr://status', () => {})
  un()
  const modelsState = received.find((p) => p.status === 'models_state')
  return JSON.stringify({
    eventCount: received.length,
    statuses: [...new Set(received.map((p) => p.status))],
    hasModelsState: !!modelsState,
    modelRoot: modelsState?.model_root,
    proxy: modelsState?.proxy,
    diskFreeGb: modelsState?.disk_free_gb,
    modelCount: modelsState?.models?.length,
    firstModel: modelsState?.models?.[0] ? {
      name: modelsState.models[0].name,
      kind: modelsState.models[0].kind,
      format: modelsState.models[0].format,
      engine: modelsState.models[0].engine,
      runtime_key: modelsState.models[0].runtime_key,
      source: modelsState.models[0].source,
      state: modelsState.models[0].state,
      entries: modelsState.models[0].entries?.length,
      cpu: modelsState.models[0].cpu,
      language_mode: modelsState.models[0].language_mode,
      voice_mode: modelsState.models[0].voice_mode,
      supports_clone: modelsState.models[0].supports_clone,
      runtime_keys: modelsState.models[0].runtime_keys
    } : null
  })
})()`)

console.log(typeof out === 'object' ? JSON.stringify(out, null, 2) : out)
ws.close()
process.exit(0)
