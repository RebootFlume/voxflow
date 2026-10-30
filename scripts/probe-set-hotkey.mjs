/**
 * 精确探测 set_hotkey 的返回/报错（CDP）。
 * 用法：node scripts/probe-set-hotkey.mjs [port]
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
    pending.set(i, (m) => {
      if (m.result?.exceptionDetails) resolve('EXCEPTION: ' + (m.result.exceptionDetails.exception?.description ?? ''))
      else resolve(JSON.stringify(m.result?.result?.value))
    })
    ws.send(
      JSON.stringify({
        id: i,
        method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true }
      })
    )
  })

const run = (hk) =>
  ev(`window.voxflow.invoke('set_hotkey', { hotkey: ${JSON.stringify(hk)} })
        .then((r) => ({ ok: true, r }))
        .catch((e) => ({ ok: false, err: String(e && e.message ? e.message : e) }))`)

for (const hk of ['F9', 'F12', 'Bogus', '', 'CapsLock', 'Alt+Space']) {
  console.log(`${JSON.stringify(hk).padEnd(12)} => ${await run(hk)}`)
}
console.log('unknown cmd  =>', await ev(`window.voxflow.invoke('no_such_command').then(r => ({ok:true,r})).catch(e => ({ok:false,err:String(e.message)}))`))
ws.close()
process.exit(0)
