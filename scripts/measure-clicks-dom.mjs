/**
 * 点击卡顿实测（DOM 口径，CDP）：点侧栏标签，量「点击 → DOM 真的变了」的耗时。
 *
 * 为什么不用 rAF：`measure-clicks.mjs` 用 requestAnimationFrame 量「两帧画完」，
 * 而 Chromium 对**不可见 / 被遮挡**的窗口会节流甚至停掉 rAF —— 窗口没显示时
 * 那个脚本会量出几十秒的假卡顿。这里改成用 MutationObserver 等 DOM 变更：
 * MutationObserver 不受窗口可见性影响，量到的是「事件处理 + React 渲染提交」
 * 这段真实主线程耗时（不含最终上屏的绘制）。
 *
 * 用法（应用需带 --remote-debugging-port 启动）：
 *   node scripts/measure-clicks-dom.mjs [port]
 */
import { WebSocket } from 'ws'

const port = process.argv[2] ?? '9450'
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
  ws.send(
    JSON.stringify({
      id: msgId,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true }
    })
  )
  return new Promise((resolve) => {
    pending.set(msgId, (m) => {
      if (m.result?.exceptionDetails) {
        resolve('ERR: ' + (m.result.exceptionDetails.exception?.description ?? 'eval error'))
      } else resolve(m.result?.result?.value)
    })
  })
}

const vis = await evaluate(
  `({ visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() })`
)
console.log('页面可见性:', JSON.stringify(vis))
if (vis?.hidden) {
  console.log('（窗口不可见：绘制被 Chromium 节流，rAF 口径的"帧间隔"不可信，故用 DOM 口径）')
}

const labels = await evaluate(`[...document.querySelectorAll('aside button[aria-label]')].map(b => b.getAttribute('aria-label'))`)
console.log('侧栏按钮:', JSON.stringify(labels))

// 长任务 + IPC 往返观测
await evaluate(`(() => {
  window.__j = { longtasks: [], ipc: [] };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__j.longtasks.push(Math.round(e.duration));
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  window.__j.run = true;
  (async () => {
    while (window.__j.run) {
      const t0 = performance.now();
      try { await window.voxflow.invoke('rust_get_status'); } catch {}
      window.__j.ipc.push(Math.round(performance.now() - t0));
      await new Promise(r => setTimeout(r, 150));
    }
  })();
  return true;
})()`)

/** 点一个按钮，等 DOM 真的发生变化，返回耗时（ms）；超时返回 -1 */
const clickExpr = `(async (label) => {
  const el = [...document.querySelectorAll('aside button[aria-label]')].find(b => b.getAttribute('aria-label') === label);
  if (!el) return null;
  const t0 = performance.now();
  const changed = new Promise((resolve) => {
    const mo = new MutationObserver(() => { mo.disconnect(); resolve(performance.now() - t0); });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  });
  el.click();
  const ms = await Promise.race([changed, new Promise((r) => setTimeout(() => r(-1), 8000))]);
  return Math.round(ms);
})`

// 阶段 A：逐个点击侧栏
const phaseA = []
for (const name of Array.isArray(labels) ? labels : []) {
  phaseA.push([name, await evaluate(`${clickExpr}(${JSON.stringify(name)})`)])
  await new Promise((r) => setTimeout(r, 350))
}

// 阶段 B：并行触发一次冷显存查询的同时连续点击
await new Promise((r) => setTimeout(r, 5200))
const phaseB = await evaluate(`(async () => {
  window.__j.longtasks.length = 0;
  const slow = window.voxflow.invoke('get_vram_status').catch(() => null);
  const els = [...document.querySelectorAll('aside button[aria-label]')];
  const out = [];
  for (let i = 0; i < 8; i++) {
    const el = els[i % els.length];
    const t0 = performance.now();
    const changed = new Promise((resolve) => {
      const mo = new MutationObserver(() => { mo.disconnect(); resolve(performance.now() - t0); });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    });
    el.click();
    const ms = await Promise.race([changed, new Promise((r) => setTimeout(() => r(-1), 8000))]);
    out.push([el.getAttribute('aria-label'), Math.round(ms)]);
    await new Promise((r) => setTimeout(r, 220));
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
    ipcP50: q(s.ipc.slice(-100), 0.5),
    ipcP95: q(s.ipc.slice(-100), 0.95),
    ipcMax: Math.max(0, ...s.ipc.slice(-100))
  };
})()`)

console.log('\n【阶段 A：普通点击 · 点击→DOM 变更】')
for (const [name, ms] of phaseA) console.log(`  ${name}: ${ms}ms`)
console.log('\n【阶段 B：冷显存查询并行时点击】')
for (const [name, ms] of Array.isArray(phaseB) ? phaseB : []) console.log(`  ${name}: ${ms}ms`)
console.log('\n【渲染进程长任务 > 50ms】', snap.longtasks.length ? snap.longtasks.join(', ') : '（无）')
console.log(`【IPC 往返】p50=${snap.ipcP50}ms p95=${snap.ipcP95}ms max=${snap.ipcMax}ms`)

ws.close()
process.exit(0)
