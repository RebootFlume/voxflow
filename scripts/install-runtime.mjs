/**
 * 真实安装推理框架运行时（完整链路：下载 → 解压 → 落位 → 完整性校验 → 试启动）。
 *
 * 会下载数百 MB，仅用于人工验证，不进常规测试集。
 * 用法：node scripts/install-runtime.mjs [port] [framework]
 */
import { WebSocket } from 'ws'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const port = process.argv[2] ?? '9222'
const framework = process.argv[3] ?? 'gguf'
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

console.log(`开始安装运行时：${framework}（可能需要几分钟）`)
const t0 = Date.now()

const result = await evaluate(`(async () => {
  const events = []
  const un = await window.voxflow.listen('sidecar://event', (p) => {
    if (String(p.status || '').startsWith('runtime_')) {
      events.push({ status: p.status, progress: p.progress, phase: p.phase, msg: p.msg });
      console.log('[' + p.status + ']', p.progress != null ? p.progress + '%' : (p.phase || p.msg || ''));
    }
  });
  await window.voxflow.invoke('download_runtime', { framework: ${JSON.stringify(framework)} }).catch(e => {
    console.log('调用返回:', e && e.message);
  });
  // 等终态事件
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    if (events.some(e => e.status === 'runtime_installed' || e.status === 'runtime_download_error' || e.status === 'runtime_download_cancelled')) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  un();
  return JSON.stringify(events.slice(-6));
})()`)

const parsed = typeof result === 'string' ? JSON.parse(result) : result
console.log('\n最后事件:', JSON.stringify(parsed, null, 2))
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)

// 落盘结果
const pkgDirs = {
  gguf: 'llama-cpp',
  onnx: 'sherpa-onnx'
}
const dir = join(LIBS, pkgDirs[framework] ?? framework)
if (existsSync(dir)) {
  const files = readdirSync(dir)
  console.log(`\n落盘目录 ${dir}:`)
  for (const f of files.slice(0, 15)) {
    const st = statSync(join(dir, f))
    const suffix = st.isDirectory() ? '/' : `  (${(st.size / 1024 / 1024).toFixed(1)} MB)`
    console.log(`  ${f}${suffix}`)
  }
} else {
  console.log(`\n落盘目录不存在: ${dir}`)
}

// 最终状态
const status = await evaluate(
  `window.voxflow.invoke('check_runtime').then(r => JSON.stringify(r.packages.find(p => p.framework === ${JSON.stringify(framework)})))`
)
console.log('\n最终状态:', status)

ws.close()
process.exit(0)
