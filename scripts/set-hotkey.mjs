/**
 * 设置录音热键（走主进程 set_hotkey，和界面改热键同一条路径）。
 * 用法：node scripts/set-hotkey.mjs F9 [port]
 */
import { WebSocket } from 'ws'

const hotkey = process.argv[2]
const port = process.argv[3] ?? '9446'
if (!hotkey) {
  console.error('用法: node scripts/set-hotkey.mjs <hotkey> [port]')
  process.exit(1)
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
const expr = `window.voxflow.invoke('set_hotkey', { hotkey: ${JSON.stringify(hotkey)} })
  .then(() => 'OK')
  .catch((e) => 'ERR: ' + e.message)`
const msgId = ++id
pending.set(msgId, (m) => {
  console.log(`${hotkey} =>`, m.result?.result?.value)
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
