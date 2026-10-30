/**
 * 逐命令延迟采样（CDP，在已启动的应用上跑）：找出 `list_models` 里真正的耗时点。
 * 用法：node scripts/probe-ipc-latency.mjs [port]
 */
import { WebSocket } from 'ws'

const port = process.argv[2] ?? '9444'
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
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
await new Promise((r) => ws.on('open', r))

function evaluate(expr) {
  const msgId = ++id
  return new Promise((resolve) => {
    pending.set(msgId, (m) => {
      if (m.result?.exceptionDetails) resolve('ERR ' + (m.result.exceptionDetails.text ?? ''))
      else resolve(m.result?.result?.value)
    })
    ws.send(
      JSON.stringify({
        id: msgId,
        method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true }
      })
    )
  })
}

const time = (expr) =>
  evaluate(`(() => { const t = performance.now(); return (${expr}).then(() => Math.round(performance.now() - t)) })()`)

const cases = [
  ['rust_get_status', `window.voxflow.invoke('rust_get_status')`],
  ['get_data_root_info', `window.voxflow.invoke('get_data_root_info')`],
  ['check_runtime', `window.voxflow.invoke('check_runtime')`],
  ['get_gpu_info', `window.voxflow.invoke('get_gpu_info')`],
  ['get_vram_status', `window.voxflow.invoke('get_vram_status')`],
  ['get_vram_status(2)', `window.voxflow.invoke('get_vram_status')`],
  ['list_models', `window.voxflow.invoke('send_to_sidecar_safe',{payload:{action:'list_models'}})`],
  ['list_models(2)', `window.voxflow.invoke('send_to_sidecar_safe',{payload:{action:'list_models'}})`],
  ['list_models(3)', `window.voxflow.invoke('send_to_sidecar_safe',{payload:{action:'list_models'}})`]
]

for (const [name, expr] of cases) {
  const ms = await time(expr)
  console.log(`${name.padEnd(20)} ${ms}ms`)
}

ws.close()
process.exit(0)
