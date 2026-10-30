/**
 * 把应用窗口拉到前台（CDP `Page.bringToFront`），并回读页面可见性。
 *
 * 背景：`measure-clicks.mjs` 用 rAF 量点击耗时，Chromium 对不可见窗口会节流 rAF，
 * 量出来的「点击耗时」是节流假象。先把窗口提到前台，再量才有意义。
 *
 * 用法：node scripts/bring-to-front.mjs [port]
 */
import { WebSocket } from 'ws'

const port = process.argv[2] ?? '9450'
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
await new Promise((r) => ws.on('open', r))

function send(method, params = {}) {
  const msgId = ++id
  ws.send(JSON.stringify({ id: msgId, method, params }))
  return new Promise((resolve) => pending.set(msgId, (m) => resolve(m)))
}

async function evaluate(expr) {
  const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  return m.result?.result?.value
}

await send('Page.bringToFront')
await new Promise((r) => setTimeout(r, 800))
console.log(
  JSON.stringify(
    await evaluate(`({ visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() })`),
    null,
    2
  )
)
ws.close()
