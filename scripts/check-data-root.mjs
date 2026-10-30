/**
 * 查询运行中应用实际使用的数据根 / 模型根（CDP）。
 * 用法：node scripts/check-data-root.mjs [port]
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

console.log('get_data_root_info =', await ev(`window.voxflow.invoke('get_data_root_info')`))
console.log('check_runtime.root =', JSON.stringify((await ev(`window.voxflow.invoke('check_runtime')`)).root))
ws.close()
process.exit(0)
