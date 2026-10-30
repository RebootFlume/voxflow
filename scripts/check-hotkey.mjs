/**
 * 检查录音热键在主进程是否真的被接受（CDP）。
 * 渲染端改热键时只本地记一条日志，主进程若解析失败会被 useHotkeySync 的 .catch 吞掉——
 * 这里直接把 set_hotkey 的结果打出来。
 * 用法：node scripts/check-hotkey.mjs [port]
 */
import { WebSocket } from 'ws'

const port = process.argv[2] ?? '9446'
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
const ev = (expr) =>
  new Promise((resolve) => {
    const i = ++id
    pending.set(i, (m) => resolve(m.result?.result?.value))
    ws.send(
      JSON.stringify({
        id: i,
        method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true }
      })
    )
  })

const test = async (hotkey) => {
  const expr = `window.voxflow.invoke('set_hotkey', { hotkey: ${JSON.stringify(hotkey)} })
    .then(() => 'ACCEPTED')
    .catch((e) => 'REJECTED: ' + e.message)`
  const r = await ev(expr)
  console.log(`${hotkey.padEnd(12)} => ${r}`)
}

for (const hk of ['F1', 'F5', 'F9', 'F12', 'CapsLock', 'Alt+Space', 'Ctrl+Shift+K', 'Ctrl+Q']) {
  await test(hk)
}
ws.close()
process.exit(0)
