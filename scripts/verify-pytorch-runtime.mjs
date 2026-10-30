/**
 * PyTorch 运行时真机验证（阶段三-c 收尾）。
 *
 * 全程走产品自身的代码路径：
 *   1. download_runtime('pytorch-cpu')  → 真实下载 800MB 运行时包
 *   2. rust_verify_runtime('pytorch-cpu') → 完整性校验 + 试启动（真跑 torch 的 smoke test）
 *   3. rust_pytorch_device_info('cpu')   → 真起 worker 问 runtime_info（torch 版本 / CUDA 可用性）
 *
 * 用法：node scripts/verify-pytorch-runtime.mjs [port]
 */
import { WebSocket } from 'ws'

const port = process.argv[2] ?? '9222'
const FRAMEWORK = 'pytorch-cpu'

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

async function call(cmd, args = {}) {
  return evaluate(
    `window.voxflow.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})
      .then(r => ({ ok: true, r }))
      .catch(e => ({ ok: false, err: String(e && e.message || e) }))`
  )
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

console.log('\n【PyTorch 运行时真机验证】')

// 1. 触发真实下载（约 800MB）
console.log(`  … 下载 ${FRAMEWORK} 运行时（约 800MB，走真实下载链路）`)
await evaluate('window.__vfEvents = []; 1')
const dl = await call('download_runtime', { framework: FRAMEWORK })
check('download_runtime 被接受', dl.ok === true, JSON.stringify(dl))

const t0 = Date.now()
let lastPct = -1
let installed = false
let lastErr = ''
while (Date.now() - t0 < 45 * 60 * 1000) {
  const evs = await evaluate(
    `JSON.stringify((window.__vfEvents || []).filter(p => String(p.status||'').startsWith('runtime_')))`
  )
  const arr = JSON.parse(evs || '[]')
  for (const e of arr) {
    if (e.status === 'runtime_download_progress' && e.progress !== lastPct) {
      lastPct = e.progress
      process.stdout.write(`\r    下载进度 ${e.progress}%  (${((Date.now() - t0) / 1000).toFixed(0)}s)   `)
    }
    if (e.status === 'runtime_installed') installed = true
    if (e.status === 'runtime_download_error' || e.status === 'runtime_download_cancelled') {
      lastErr = e.msg ?? ''
    }
  }
  if (installed || lastErr) break
  await new Promise((r) => setTimeout(r, 1000))
}
process.stdout.write('\r')
check('运行时安装完成（runtime_installed）', installed, lastErr)

if (!installed) {
  console.log('    失败原因: ' + lastErr.slice(0, 500))
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
  ws.close()
  process.exit(1)
}

// 2. 验证（完整性 + 试启动：真跑 torch 的 smoke test）
console.log('  … rust_verify_runtime（完整性校验 + 真 torch smoke test）')
const verify = await call('rust_verify_runtime', { framework: FRAMEWORK })
check('rust_verify_runtime 返回 ready', verify.ok && verify.r.state === 'ready', JSON.stringify(verify).slice(0, 400))
check('无缺失文件', verify.ok && Array.isArray(verify.r.missing) && verify.r.missing.length === 0, JSON.stringify(verify.r?.missing))

// 3. 设备探测（真起 worker 问 runtime_info）
console.log('  … rust_pytorch_device_info（真起 Python worker）')
const probe = await call('rust_pytorch_device_info', { device: 'cpu' })
check('设备探测成功', probe.ok && probe.r.ok === true, JSON.stringify(probe).slice(0, 400))
const info = probe.ok ? probe.r.info : null
if (info) {
  check('python 版本已上报', typeof info.python === 'string' && info.python.length > 0, JSON.stringify(info))
  check('torch 版本已上报', typeof info.torch === 'string' && info.torch.startsWith('2.14.0'), JSON.stringify(info))
  check('cuda_available 为布尔', typeof info.cuda_available === 'boolean', JSON.stringify(info))
  check('device_count 为数字', typeof info.device_count === 'number', JSON.stringify(info))
  console.log(`    → python ${info.python} / torch ${info.torch} / cuda_available=${info.cuda_available}`)
} else {
  check('设备探测返回可读错误', !!probe.r?.error, JSON.stringify(probe))
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
ws.close()
process.exit(fail > 0 ? 1 : 0)
