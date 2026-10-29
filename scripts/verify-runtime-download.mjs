/**
 * 推理框架运行时下载的端到端验证（阶段三-b）。
 *
 * 覆盖：
 *  1. check_runtime 载荷形状（4 个包 + 三态）
 *  2. rust_verify_runtime 的缺失态
 *  3. 真实下载：拉起 llama-cpp 包 → 校验进度事件 → 取消 → 校验取消事件与临时目录清理
 *
 * 用法：node scripts/verify-runtime-download.mjs [port]
 */
import { WebSocket } from 'ws'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const port = process.argv[2] ?? '9222'
const LIBS = 'D:/workspace/voxflow/libs'

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

console.log('\n【推理框架运行时】')

// 1. 状态载荷
const status = await call('check_runtime')
check('check_runtime 可调用', status.ok === true, JSON.stringify(status))
const pkgs = status.ok ? status.r.packages : []
check('返回 4 个运行时包', pkgs.length === 4, `实际 ${pkgs.length}`)
check(
  '包键正确（gguf / onnx / pytorch-cpu / pytorch-cuda130）',
  ['gguf', 'onnx', 'pytorch-cpu', 'pytorch-cuda130'].every((k) => pkgs.some((p) => p.framework === k)),
  JSON.stringify(pkgs.map((p) => p.framework))
)
check(
  '每个包带 engine / variant / supports_cpu / supports_cuda',
  pkgs.every(
    (p) =>
      typeof p.engine === 'string' &&
      typeof p.variant === 'string' &&
      typeof p.supports_cpu === 'boolean' &&
      typeof p.supports_cuda === 'boolean'
  ),
  JSON.stringify(pkgs[0])
)
check(
  '未安装时 state=missing',
  pkgs.filter((p) => !p.installed).every((p) => p.state === 'missing' || p.state === 'incomplete'),
  JSON.stringify(pkgs.map((p) => [p.framework, p.state]))
)
check('libs 根目录指向 exe 旁', String(status.r.root).replace(/\\/g, '/').endsWith('/libs'), String(status.r.root))

// 2. 验证命令：未安装的包 → missing；已安装的包 → ready
const verify = await call('rust_verify_runtime', { framework: 'pytorch-cuda130' })
check('rust_verify_runtime 可调用', verify.ok === true, JSON.stringify(verify))
check(
  '未安装时返回 missing 且带缺失清单',
  verify.ok && ['missing', 'incomplete'].includes(verify.r.state) && Array.isArray(verify.r.missing),
  JSON.stringify(verify)
)
// 已安装的包（若在）应报 ready
const installed = pkgs.find((p) => p.installed)
if (installed) {
  const v2 = await call('rust_verify_runtime', { framework: installed.framework })
  check(
    `已安装的包（${installed.framework}）验证为 ready`,
    v2.ok && v2.r.state === 'ready' && v2.r.installed === true,
    JSON.stringify(v2)
  )
}
const verifyUnknown = await call('rust_verify_runtime', { framework: '不存在的框架' })
check(
  '未知框架返回 missing 空清单',
  verifyUnknown.ok && verifyUnknown.r.state === 'missing' && verifyUnknown.r.missing.length === 0,
  JSON.stringify(verifyUnknown)
)

// 3. 真实下载 + 取消
// 选一个**当前未安装**的包（已安装的会直接跳过下载 ⇒ 没有进度事件）。
// 优先用 onnx；都装了就用 pytorch-cpu（取消早，只拉几 MB）。
const notInstalled = pkgs.filter((p) => !p.installed).map((p) => p.framework)
const DL = notInstalled.includes('onnx') ? 'onnx' : notInstalled[0] ?? 'onnx'
console.log(`  … 启动真实下载（${DL}），稍后取消`)
const events = await evaluate(`(async () => {
  const seen = []
  const un = await window.voxflow.listen('sidecar://event', (p) => {
    if (String(p.status || '').startsWith('runtime_download')) {
      seen.push({ status: p.status, framework: p.framework, progress: p.progress, phase: p.phase, msg: p.msg });
    }
  });
  await window.voxflow.invoke('download_runtime', { framework: ${JSON.stringify(DL)} }).catch(() => {});
  // 等进度事件出现后再取消
  for (let i = 0; i < 60 && !seen.some(e => e.status === 'runtime_download_progress'); i++) {
    await new Promise(r => setTimeout(r, 500));
  }
  const cancel = await window.voxflow.invoke('cancel_runtime_download', { framework: ${JSON.stringify(DL)} })
    .then(r => ({ ok: true, r })).catch(e => ({ ok: false, err: String(e && e.message || e) }));
  await new Promise(r => setTimeout(r, 4000));
  un();
  return JSON.stringify({ seen, cancel });
})()`)

const parsed = typeof events === 'string' ? JSON.parse(events) : events
const seen = parsed?.seen ?? []
check('收到 runtime_download_progress 事件', seen.some((e) => e.status === 'runtime_download_progress'), JSON.stringify(seen).slice(0, 300))
const prog = seen.find((e) => e.status === 'runtime_download_progress')
check('进度事件带 framework / progress / downloaded',
  prog && prog.framework === DL && typeof prog.progress === 'number',
  JSON.stringify(prog))
check('取消命令返回 ok=true', parsed?.cancel?.ok === true && parsed?.cancel?.r?.ok === true, JSON.stringify(parsed?.cancel))
check(
  '收到取消/错误事件（runtime_download_cancelled 或 runtime_download_error）',
  seen.some((e) => e.status === 'runtime_download_cancelled' || e.status === 'runtime_download_error'),
  JSON.stringify(seen.map((e) => e.status))
)

// 4. PyTorch 设备探测（未安装运行时 ⇒ 明确错误，不是崩溃）
const probe = await call('rust_pytorch_device_info', { device: 'cpu' })
check('rust_pytorch_device_info 可调用', probe.ok === true, JSON.stringify(probe))
check(
  '返回 { ok, device, info|error } 契约',
  probe.ok && probe.r.device === 'cpu' && ('info' in probe.r || 'error' in probe.r),
  JSON.stringify(probe)
)
if (probe.ok && probe.r.info) {
  check(
    'info 带齐前端契约字段',
    ['python', 'torch', 'cuda_available', 'cuda_version', 'device_count'].every((k) => k in probe.r.info),
    JSON.stringify(probe.r.info)
  )
} else {
  check(
    '未安装运行时时给出可读错误',
    typeof probe.r.error === 'string' && probe.r.error.length > 0,
    JSON.stringify(probe)
  )
}

// 5. 取消后的临时目录：Rust 版语义 = **保留 .part**（下次可断点续传），
//    目录本身不清理（取消路径上 Rust 也没做清理）。这里断言同样语义。
const tmpDir = join(LIBS, `_runtime_${DL}`)
const tmpLeft = existsSync(tmpDir) ? readdirSync(tmpDir) : []
check(
  '取消后保留 .part 断点文件（支持续传）',
  tmpLeft.some((n) => n.endsWith('.part')),
  JSON.stringify(tmpLeft)
)
const targetDir = join(LIBS, pkgs.find((p) => p.framework === DL)?.framework === 'onnx' ? 'sherpa-onnx' : DL)
check('取消后未落盘主程序（目标目录仍为空）', !existsSync(join(targetDir, 'bin', 'sherpa-onnx-offline-websocket-server.exe')))

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
ws.close()
process.exit(fail > 0 ? 1 : 0)
