/**
 * 验证「录音采集链路」是否正常（主进程 → 渲染进程 getUserMedia → 回传样本 → 写 WAV）。
 *
 * 走的是和热键录音完全相同的 `startCapture`/`stopCapture` 中继，只是入口换成
 * TTS 克隆参考音频命令（`rust_record_tts_reference`，录 N 秒定长）。
 * 热键本身（uiohook 收到按键）用 `scripts/check-hotkey.mjs` / 手动按 F9 验证。
 *
 * 用法：node scripts/test-capture.mjs [seconds] [port]
 */
import { WebSocket } from 'ws'

const seconds = Number(process.argv[2] ?? 3)
const port = process.argv[3] ?? '9446'
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
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

const expr = `(async () => {
  const t = performance.now();
  try {
    const r = await window.voxflow.invoke('rust_record_tts_reference', { seconds: ${seconds} });
    return { ok: true, ms: Math.round(performance.now() - t), r };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t), err: String(e && e.message ? e.message : e) };
  }
})()`
const msgId = ++id
pending.set(msgId, (m) => {
  const v = m.result?.result?.value
  console.log(JSON.stringify(v, null, 2))
  ws.close()
  process.exit(v?.ok ? 0 : 1)
})
ws.send(
  JSON.stringify({
    id: msgId,
    method: 'Runtime.evaluate',
    params: { expression: expr, returnByValue: true, awaitPromise: true }
  })
)
