/**
 * 卡顿回归验证：证明主进程不再被 WMI 查询阻塞。
 *
 * 做法：一边发起 get_vram_status（内部要跑 3.3s 的 WMI 查询），
 * 一边连续发一个"极轻量"的 IPC 命令（rust_get_status），测它的往返延迟。
 *   - 修好前：主线程被 spawnSync 占住 → 轻量命令延迟飙到 3s+（点按钮就卡）
 *   - 修好后：轻量命令延迟应保持在几十毫秒
 *
 * 用法：node scripts/verify-no-blocking.mjs [port]
 */
import { WebSocket } from 'ws'

const port = process.argv[2] ?? '9222'

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

console.log('\n【主线程阻塞回归】')

// 1. get_vram_status 单次耗时（冷调用，会真跑 WMI）
const t1 = Date.now()
const v1 = await evaluate(
  `window.voxflow.invoke('get_vram_status').then(r => JSON.stringify(r)).catch(e => 'ERR:' + e.message)`
)
const dur1 = Date.now() - t1
const ok1 = typeof v1 === 'string' && v1.startsWith('{')
check('get_vram_status 返回正常', ok1, String(v1).slice(0, 200))
console.log(`    冷调用耗时 ${dur1}ms（含 WMI；慢但不再阻塞 UI）`)

// 2. 立刻再调一次 → 命中 TTL 缓存，应明显更快
const t2 = Date.now()
const v2 = await evaluate(
  `window.voxflow.invoke('get_vram_status').then(r => JSON.stringify(r)).catch(e => 'ERR:' + e.message)`
)
const dur2 = Date.now() - t2
check('第二次调用命中缓存（< 1s）', dur2 < 1000, `${dur2}ms`)
check('缓存结果仍然有效', typeof v2 === 'string' && v2.startsWith('{'), String(v2).slice(0, 120))
console.log(`    缓存调用耗时 ${dur2}ms`)

// 3. 关键：并发发起 get_vram_status（强制走真 WMI 路径：等缓存过期后再打）
//    同时连续探测轻量命令的往返延迟
console.log('  … 并发压力：一个慢命令 + 连续轻量命令')
await new Promise((r) => setTimeout(r, 5200)) // 等 TTL(5s) 过期

const probe = await evaluate(`(async () => {
  // 不等它完成：故意让它在后台跑（内部是 3.3s 的 WMI）
  const slow = window.voxflow.invoke('get_vram_status').catch(() => null);
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const t0 = performance.now();
    await window.voxflow.invoke('rust_get_status');
    samples.push(Math.round(performance.now() - t0));
    await new Promise(r => setTimeout(r, 250));
  }
  await slow;
  return JSON.stringify(samples);
})()`)

const samples = JSON.parse(probe || '[]')
const max = Math.max(...samples)
const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
console.log(`    轻量命令延迟样本(ms): ${samples.join(', ')}`)
console.log(`    平均 ${avg}ms / 最大 ${max}ms`)
check('慢命令在跑时，轻量命令不被阻塞（最大 < 800ms）', max < 800, `最大 ${max}ms`)
check('轻量命令平均延迟很低（< 200ms）', avg < 200, `平均 ${avg}ms`)

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
ws.close()
process.exit(fail > 0 ? 1 : 0)
