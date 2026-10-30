/**
 * 点击卡顿实测（CDP）：点侧栏标签，量「点击 → 两帧画完」的耗时，
 * 同时记录渲染进程长任务、帧间隔、并发 IPC 往返延迟。
 *
 * 用法（应用需带 --remote-debugging-port 启动）：
 *   node scripts/measure-clicks.mjs [port]
 */
import { WebSocket } from 'ws'

const port = process.argv[2] ?? '9446'
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
await new Promise((r) => ws.on('open', r))

function evaluate(expr) {
  const msgId = ++id
  return new Promise((resolve) => {
    pending.set(msgId, (m) => {
      if (m.result?.exceptionDetails) {
        resolve('ERR: ' + (m.result.exceptionDetails.exception?.description ?? 'eval error'))
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

const labels = await evaluate(`[...document.querySelectorAll('aside button[aria-label]')].map(b => b.getAttribute('aria-label'))`)
console.log('侧栏按钮:', JSON.stringify(labels))

// 观测器：长任务 + 帧间隔 + 并发 IPC 延迟
await evaluate(`(() => {
  window.__j = { longtasks: [], frames: [], ipc: [] };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__j.longtasks.push(Math.round(e.duration));
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  let last = performance.now();
  const tick = (now) => { const d = now - last; last = now; window.__j.frames.push(Math.round(d)); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__j.run = true;
  (async () => {
    while (window.__j.run) {
      const t0 = performance.now();
      try { await window.voxflow.invoke('rust_get_status'); } catch {}
      window.__j.ipc.push(Math.round(performance.now() - t0));
      await new Promise(r => setTimeout(r, 120));
    }
  })();
  return true;
})()`)

// 阶段 A：普通点击（顺序点所有侧栏项）
const names = Array.isArray(labels) ? labels : []
const results = []
for (const name of names) {
  const r = await evaluate(`(async () => {
    const el = [...document.querySelectorAll('aside button[aria-label]')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(name)});
    if (!el) return null;
    const t0 = performance.now();
    el.click();
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 0));
    return Math.round(performance.now() - t0);
  })()`)
  results.push([name, r])
  await new Promise((r) => setTimeout(r, 400))
}

// 阶段 B：强迫一次冷显存查询，同时连续点击（复现「后台查显存时点按钮」）
await new Promise((r) => setTimeout(r, 5200))
const phaseB = await evaluate(`(async () => {
  window.__j.longtasks.length = 0; window.__j.frames.length = 0; window.__j.ipc.length = 0;
  const slow = window.voxflow.invoke('get_vram_status').catch(() => null);
  const els = [...document.querySelectorAll('aside button[aria-label]')];
  const out = [];
  for (let i = 0; i < 8; i++) {
    const el = els[i % els.length];
    const t0 = performance.now();
    el.click();
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 0));
    out.push([el.getAttribute('aria-label'), Math.round(performance.now() - t0)]);
    await new Promise(r => setTimeout(r, 220));
  }
  await slow;
  return out;
})()`)

const snap = await evaluate(`(() => {
  window.__j.run = false;
  const s = window.__j;
  const q = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
  return {
    longtasks: s.longtasks.slice(-30),
    frameMax: Math.max(0, ...s.frames),
    frameP95: q(s.frames, 0.95),
    ipcP50: q(s.ipc.slice(-100), 0.5),
    ipcP95: q(s.ipc.slice(-100), 0.95),
    ipcMax: Math.max(0, ...s.ipc.slice(-100))
  };
})()`)

console.log('\n【阶段 A：普通点击】')
for (const [name, ms] of results) console.log(`  ${name}: ${ms}ms`)
console.log('\n【阶段 B：冷显存查询并行时点击】')
for (const [name, ms] of Array.isArray(phaseB) ? phaseB : []) console.log(`  ${name}: ${ms}ms`)
console.log('\n【渲染进程长任务 > 50ms】', snap.longtasks.length ? snap.longtasks.join(', ') : '（无）')
console.log(`【帧间隔】max=${snap.frameMax}ms p95=${snap.frameP95}ms`)
console.log(`【IPC 往返】p50=${snap.ipcP50}ms p95=${snap.ipcP95}ms max=${snap.ipcMax}ms`)

ws.close()
process.exit(0)
