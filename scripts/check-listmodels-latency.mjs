/**
 * 在已启动的应用上量化 `list_models` 的耗时（CDP）。
 *
 * 背景：`list_models` 会给每个已安装条目算显存预估 → 读 GGUF 元数据。
 * 旧实现单次 GGUF 解析实测 7.2 秒（同步、跑在主线程），模型页/启动会被它卡死。
 * 用法：node scripts/check-listmodels-latency.mjs [port]
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
      if (m.result?.exceptionDetails) {
        resolve({ error: m.result.exceptionDetails.exception?.description ?? 'eval error' })
      } else resolve(m.result?.result?.value)
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

const measure = () =>
  evaluate(`(() => {
    const t = performance.now();
    return window.voxflow
      .invoke('send_to_sidecar_safe', { payload: { action: 'list_models' } })
      .then(() => Math.round(performance.now() - t));
  })()`)

const cold = await measure()
const warm = await measure()
const warm2 = await measure()
console.log(`list_models 耗时: 冷=${cold}ms 热=${warm}ms 热2=${warm2}ms`)
ws.close()
process.exit(0)
