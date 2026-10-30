/**
 * 检查标题栏左侧图标在运行时的真实状态（CDP）：currentSrc / 是否加载成功 / 实际渲染尺寸。
 * 并截一张左上角小图，便于肉眼确认。
 * 用法：node scripts/inspect-title-icon.mjs [port] [outPng]
 */
import { WebSocket } from 'ws'
import { writeFileSync } from 'node:fs'

const port = process.argv[2] ?? '9446'
const out = process.argv[3] ?? 'C:/Users/xiaoda/AppData/Local/Temp/vf-title-icon.png'
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
  const m = JSON.parse(raw.toString())
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
await new Promise((r) => ws.on('open', r))
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id
    pending.set(i, resolve)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const evaluate = async (expr) => {
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) return { error: res.result.exceptionDetails.exception?.description }
  return res.result?.result?.value
}

const info = await evaluate(`(() => {
  const img = document.querySelector('img[alt="VoxFlow"]');
  if (!img) return { found: false };
  const r = img.getBoundingClientRect();
  const cs = getComputedStyle(img);
  return {
    found: true,
    src: img.getAttribute('src'),
    currentSrc: img.currentSrc,
    complete: img.complete,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    objectFit: cs.objectFit,
    pageUrl: location.href
  };
})()`)
console.log(JSON.stringify(info, null, 2))

// 截左上角区域
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: false,
  clip: { x: 0, y: 0, width: 260, height: 40, scale: 4 }
})
if (shot.result?.data) {
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
  console.log('截图已保存:', out)
} else {
  console.log('截图失败:', JSON.stringify(shot).slice(0, 200))
}
ws.close()
process.exit(0)
