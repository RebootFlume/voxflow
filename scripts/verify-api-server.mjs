/**
 * OpenAI 兼容对外 API 的端到端验证（阶段三-d）。
 *
 * 覆盖：鉴权 / 路由 / 错误码 / multipart 解析 / WAV 编码。
 * 不需要真实模型：ASR 与 TTS 在无引擎时返回 500（错误分支也是契约的一部分）。
 *
 * 用法：node scripts/verify-api-server.mjs [port]
 */
import { WebSocket } from 'ws'

const port = process.argv[2] ?? '9222'
const API_HOST = '127.0.0.1'
// 随机高位端口：避免与上一轮测试残留的 API 服务撞端口
const API_PORT = 20000 + Math.floor(Math.random() * 20000)
const API_KEY = 'test-key-123'

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

async function evaluate(expr) {
  const res = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  })
  if (res.result?.exceptionDetails) return { __error: res.result.exceptionDetails.text }
  return res.result?.result?.value
}

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n【OpenAI 兼容 API】')

// 启动 API 服务（经 IPC 走真实路径）
const started = await evaluate(
  `window.voxflow.invoke("send_to_sidecar_safe", { payload: { action: "start_api", host: ${JSON.stringify(API_HOST)}, port: ${API_PORT}, api_key: ${JSON.stringify(API_KEY)} } })
     .then(r => JSON.stringify(r)).catch(e => "ERR:" + e.message)`
)
check('start_api 成功', started === '{"ok":true}', String(started))
await new Promise((r) => setTimeout(r, 800))

const base = `http://${API_HOST}:${API_PORT}`

// 1. 鉴权：无 key → 401
const noAuth = await fetch(`${base}/health`)
check('缺少 Authorization → 401', noAuth.status === 401, `实际 ${noAuth.status}`)
const noAuthBody = await noAuth.json()
check(
  '401 错误体符合 OpenAI 形状',
  noAuthBody?.error?.code === 401 &&
    noAuthBody?.error?.type === 'invalid_request_error' &&
    typeof noAuthBody?.error?.message === 'string',
  JSON.stringify(noAuthBody)
)

// 2. 鉴权通过
const okAuth = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${API_KEY}` } })
check('带 Bearer key → 200', okAuth.status === 200, `实际 ${okAuth.status}`)
check('health 返回 {"status":"ok"}', (await okAuth.json())?.status === 'ok')

// 3. 未知路由 → 404
const notFound = await fetch(`${base}/nope`, { headers: { Authorization: `Bearer ${API_KEY}` } })
check('未知路由 → 404', notFound.status === 404, `实际 ${notFound.status}`)
const nfBody = await notFound.json()
check('404 错误体符合 OpenAI 形状', nfBody?.error?.code === 404, JSON.stringify(nfBody))

// 4. ASR：multipart 缺 file → 400
const form = new FormData()
form.append('model', 'whisper-1')
const asrNoFile = await fetch(`${base}/v1/audio/transcriptions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}` },
  body: form
})
check('ASR 缺 file → 400', asrNoFile.status === 400, `实际 ${asrNoFile.status}`)
check(
  '400 错误消息点名字段',
  (await asrNoFile.json())?.error?.message?.includes("'file'"),
  JSON.stringify(await asrNoFile.json().catch(() => null))
)

// 5. ASR：multipart 缺 boundary → 400
const asrNoBoundary = await fetch(`${base}/v1/audio/transcriptions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'multipart/form-data' },
  body: 'x'
})
check('ASR 缺 boundary → 400', asrNoBoundary.status === 400, `实际 ${asrNoBoundary.status}`)

// 6. ASR：带 file 但无引擎 → 500（错误分支）
const form2 = new FormData()
form2.append('file', new Blob([new Uint8Array(2048)], { type: 'audio/wav' }), 'a.wav')
const asrNoEngine = await fetch(`${base}/v1/audio/transcriptions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}` },
  body: form2
})
check('ASR 无引擎 → 500', asrNoEngine.status === 500, `实际 ${asrNoEngine.status}`)

// 7. TTS：缺 input → 400
const ttsNoInput = await fetch(`${base}/v1/audio/speech`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ voice: 'alloy' })
})
check('TTS 缺 input → 400', ttsNoInput.status === 400, `实际 ${ttsNoInput.status}`)

// 8. TTS：非法 JSON → 400
const ttsBadJson = await fetch(`${base}/v1/audio/speech`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  body: '{not json'
})
check('TTS 非法 JSON → 400', ttsBadJson.status === 400, `实际 ${ttsBadJson.status}`)

// 9. TTS：无引擎 → 500
const ttsNoEngine = await fetch(`${base}/v1/audio/speech`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: '你好', voice: 'alloy' })
})
check('TTS 无引擎 → 500', ttsNoEngine.status === 500, `实际 ${ttsNoEngine.status}`)

// 10. 停止服务
const stopped = await evaluate(
  `window.voxflow.invoke("send_to_sidecar_safe", { payload: { action: "stop_api" } })
     .then(r => JSON.stringify(r)).catch(e => "ERR:" + e.message)`
)
check('stop_api 成功', stopped === '{"ok":true}', String(stopped))
await new Promise((r) => setTimeout(r, 500))
const afterStop = await fetch(`${base}/health`).catch(() => null)
check('停止后端口不再服务', afterStop === null || afterStop.status !== 200)

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
ws.close()
process.exit(fail > 0 ? 1 : 0)
