// 通过 CDP 关闭 Electron 浏览器实例（优雅退出，走 before-quit 清理子进程）
// 用法: node scripts/cdp-browser-close.mjs 9454
const port = process.argv[2] || '9222'
const res = await fetch(`http://127.0.0.1:${port}/json/version`)
const info = await res.json()
const ws = new WebSocket(info.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = (e) => reject(new Error(`ws error: ${e?.message ?? e}`))
})
ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
await new Promise((r) => setTimeout(r, 800))
console.log(`[close] 已请求关闭 ${port} 上的实例`)
process.exit(0)
