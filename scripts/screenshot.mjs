/**
 * 截图渲染进程，并可选先执行一段脚本（用于切到某个面板后再截图）。
 * 用法：node scripts/screenshot.mjs [port] [outFile] [evalFile]
 */
import { WebSocket } from 'ws'
import { writeFileSync, readFileSync } from 'fs'

const port = process.argv[2] ?? '9222'
const out = process.argv[3] ?? 'C:/Users/xiaoda/AppData/Local/Temp/opencode/vf-ui.png'
const evalFile = process.argv[4]

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

if (evalFile) {
  const expr = readFileSync(evalFile, 'utf-8')
  const res = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  })
  if (res.result?.exceptionDetails) {
    console.error('前置脚本出错:', JSON.stringify(res.result.exceptionDetails).slice(0, 400))
    process.exit(1)
  }
  console.log('前置脚本结果:', JSON.stringify(res.result?.result?.value))
  // 等待界面刷新
  await new Promise((r) => setTimeout(r, 1200))
}

const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
if (!res.result?.data) {
  console.error('截图失败:', JSON.stringify(res).slice(0, 400))
  process.exit(1)
}
const buf = Buffer.from(res.result.data, 'base64')
writeFileSync(out, buf)
console.log('已保存截图:', out, `(${buf.length} bytes)`)
ws.close()
process.exit(0)
