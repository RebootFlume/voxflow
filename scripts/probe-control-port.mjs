/**
 * 探测单实例控制端口（CDP 不需要，直接连 socket）。
 *
 * 验证「第二实例唤起主窗口」这条链路：连上控制端口 → 发握手请求 → 看应答。
 * 用法：node scripts/probe-control-port.mjs [port]
 */
import { connect } from 'node:net'

const port = Number(process.argv[2] ?? 8930)
const MAGIC = 'voxflow-control/1'

function probe(term, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const socket = connect({ host: '127.0.0.1', port })
    let buf = ''
    let done = false
    const finish = (why) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {}
      resolve({ term: JSON.stringify(term), why, buf, ms: Date.now() - t0 })
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    socket.on('error', (e) => {
      clearTimeout(timer)
      finish(`error: ${e.message}`)
    })
    socket.on('connect', () => {
      socket.write(`{"magic":"${MAGIC}","action":"show"}${term}`)
    })
    socket.setEncoding('utf-8')
    socket.on('data', (chunk) => {
      buf += chunk
      if (buf.includes('\n')) {
        clearTimeout(timer)
        finish('got-response')
      }
    })
  })
}

console.log('真换行 \\n :', JSON.stringify(await probe('\n')))
console.log('字面量 \\n :', JSON.stringify(await probe('\\n')))
console.log('无终止符  :', JSON.stringify(await probe('')))
