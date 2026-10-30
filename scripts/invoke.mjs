/**
 * 通用 IPC 调用器（CDP）：在运行中的应用里执行一条主进程命令并打印结果。
 * 用法：node scripts/invoke.mjs <command> ['{"jsonArgs":1}'] [port]
 * 例：  node scripts/invoke.mjs rust_get_status
 *       node scripts/invoke.mjs set_hotkey '{"hotkey":"F9"}'
 */
import { WebSocket } from 'ws'

const cmd = process.argv[2]
if (!cmd) {
  console.error('用法: node scripts/invoke.mjs <command> [jsonArgs] [port]')
  process.exit(1)
}
let args = {}
let port = '9446'
for (const raw of process.argv.slice(3)) {
  if (/^\d+$/.test(raw)) port = raw
  else if (raw.trim().startsWith('{')) args = JSON.parse(raw)
}
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
await new Promise((r) => ws.on('open', r))
const expr = `window.voxflow.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})
  .then((r) => ({ ok: true, r }))
  .catch((e) => ({ ok: false, err: String(e && e.message ? e.message : e) }))`
const msgId = ++id
pending.set(msgId, (m) => {
  console.log(JSON.stringify(m.result?.result?.value, null, 2))
  ws.close()
  process.exit(0)
})
ws.send(
  JSON.stringify({
    id: msgId,
    method: 'Runtime.evaluate',
    params: { expression: expr, returnByValue: true, awaitPromise: true }
  })
)
