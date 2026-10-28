/**
 * 通过 CDP 截图 Electron 渲染进程（用于人工核对 UI）。
 * 用法：node scripts/screenshot.mjs [port] [outFile]
 */
import { WebSocket } from 'ws'
import { writeFileSync } from 'fs'

const port = process.argv[2] ?? '9222'
const out = process.argv[3] ?? 'C:/Users/xiaoda/AppData/Local/Temp/opencode/vf-ui.png'

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

const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
if (!res.result?.data) {
  console.error('截图失败:', JSON.stringify(res).slice(0, 400))
  process.exit(1)
}
writeFileSync(out, Buffer.from(res.result.data, 'base64'))
console.log('已保存截图:', out, `(${Buffer.from(res.result.data, 'base64').length} bytes)`)
ws.close()
process.exit(0)
