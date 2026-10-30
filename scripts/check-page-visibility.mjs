/**
 * 查看渲染页面的可见性 / 焦点状态（CDP）。
 *
 * 用途：`measure-clicks.mjs` 用 requestAnimationFrame 量「点击 → 两帧画完」，
 * 而 Chromium 对不可见 / 被遮挡的窗口会节流甚至停掉 rAF —— 此时量到的
 * 「点击耗时」是节流造成的假象，不是真的卡顿。先确认窗口可见再解读数据。
 *
 * 用法：node scripts/check-page-visibility.mjs [port]
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

function evaluate(expr) {
  const msgId = ++id
  ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
  return new Promise((resolve) => pending.set(msgId, (m) => resolve(m.result?.result?.value)))
}

console.log(
  JSON.stringify(
    await evaluate(`({
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
      title: document.title,
      url: location.href
    })`),
    null,
    2
  )
)
ws.close()
