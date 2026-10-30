/**
 * 查看音频输入设备与麦克风权限（CDP + 注册表）。
 * 用法：node scripts/check-mic.mjs [port]
 */
import { WebSocket } from 'ws'

const port = process.argv[2] ?? '9446'
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

console.log('主进程中继的设备列表 =', JSON.stringify(await ev(`window.voxflow.invoke('rust_list_audio_devices')`), null, 2))

// 直接在渲染进程里试一次 getUserMedia，看拿到几条轨道、是否静音
const probe = await ev(`(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const tracks = stream.getTracks().map(t => ({ label: t.label, enabled: t.enabled, muted: t.muted, state: t.readyState }));
    stream.getTracks().forEach(t => t.stop());
    return { ok: true, tracks };
  } catch (e) { return { ok: false, err: String(e && e.message ? e.message : e) }; }
})()`)
console.log('getUserMedia =', JSON.stringify(probe, null, 2))
ws.close()
process.exit(0)
