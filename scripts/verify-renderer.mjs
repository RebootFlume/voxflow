/**
 * 通过 CDP 连接 Electron 渲染进程，验证 UI 渲染与 IPC 桥是否正常。
 * 用法：node scripts/verify-renderer.mjs [port]
 */
import { WebSocket } from 'ws'

const port = process.argv[2] ?? '9222'

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return res.json()
}

const targets = await listTargets()
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.error('未找到渲染进程 target:', JSON.stringify(targets.map((t) => t.type)))
  process.exit(1)
}
console.log('target:', page.title, page.url)

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

async function evaluate(expr) {
  const res = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  })
  if (res.result?.exceptionDetails) {
    return { error: res.result.exceptionDetails.text }
  }
  return res.result?.result?.value
}

const checks = {
  title: await evaluate('document.title'),
  rootChildren: await evaluate('document.getElementById("root")?.children.length ?? -1'),
  domNodes: await evaluate('document.querySelectorAll("*").length'),
  hasVoxflowApi: await evaluate('typeof window.voxflow'),
  apiMethods: await evaluate(
    'window.voxflow ? Object.keys(window.voxflow).sort().join(",") : "(none)"'
  ),
  titleBarText: await evaluate(
    'document.body.innerText.slice(0, 220).replace(/\\s+/g, " ")'
  ),
  dragRegion: await evaluate(
    'document.querySelectorAll(".app-drag-region").length'
  ),
  reactRoot: await evaluate(
    'document.getElementById("root")?.firstElementChild?.tagName ?? "(none)"'
  )
}

for (const [k, v] of Object.entries(checks)) {
  console.log(`${k.padEnd(16)} = ${typeof v === 'object' ? JSON.stringify(v) : v}`)
}

// IPC 冒烟：调用一个只读命令
const invoke = await evaluate(
  'window.voxflow.invoke("get_data_root_info").then(r => JSON.stringify(r)).catch(e => "ERR:" + e.message)'
)
console.log('invoke get_data_root_info =', invoke)

const gpu = await evaluate(
  'window.voxflow.invoke("get_gpu_info").then(r => JSON.stringify(r)).catch(e => "ERR:" + e.message)'
)
console.log('invoke get_gpu_info      =', gpu)

const runtime = await evaluate(
  'window.voxflow.invoke("check_runtime").then(r => JSON.stringify(r)).catch(e => "ERR:" + e.message)'
)
console.log('invoke check_runtime     =', runtime)

const models = await evaluate(
  'window.voxflow.invoke("send_to_sidecar_safe", { payload: { action: "list_models" } }).then(r => JSON.stringify(r)).catch(e => "ERR:" + e.message)'
)
console.log('invoke list_models       =', models)

const unknown = await evaluate(
  'window.voxflow.invoke("no_such_command").then(r => "OK?").catch(e => "ERR:" + e.message)'
)
console.log('invoke unknown command   =', unknown)

ws.close()
process.exit(0)
