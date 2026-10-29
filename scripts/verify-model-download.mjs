/**
 * 模型下载真实验证（三-a）。
 *
 * 用一个临时模型根，真实下载最小的 ASR 模型
 * （Paraformer-zh-small，74MB，GitHub release tar.bz2），走完整链路：
 *   下载 → 解压 → 落位 → 写 manifest → 条目标记为已安装 → 删除清理
 *
 * 覆盖：netDownload（断点续传/重试/原子落盘）+ 解压 + manifest + 状态回传 + 删除
 *
 * 用法：node scripts/verify-model-download.mjs [port]
 */
import { WebSocket } from 'ws'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const port = process.argv[2] ?? '9222'
const TMP_ROOT = 'C:/Users/xiaoda/AppData/Local/Temp/opencode/voxflow-dl/models'
const MODEL = 'Paraformer-zh-small'

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

async function waitFor(predicate, timeoutMs, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const got = await evaluate(`JSON.stringify((window.__vfEvents || []).filter(p => ${predicate}))`)
    const arr = JSON.parse(got || '[]')
    if (arr.length > 0) return arr
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`等待事件超时（${timeoutMs}ms）：${label}`)
}

console.log('\n【模型下载真实验证】')

// 1. 切到临时模型根
rmSync(TMP_ROOT, { recursive: true, force: true })
mkdirSync(TMP_ROOT, { recursive: true })
const setRoot = await call('send_to_sidecar_safe', {
  payload: { action: 'set_model_root', path: TMP_ROOT }
})
check('切到临时模型根', setRoot.ok === true, JSON.stringify(setRoot))
await new Promise((r) => setTimeout(r, 500))

// 2. 触发下载
await evaluate('window.__vfEvents = []; 1')
console.log(`  … 下载 ${MODEL}（约 74MB）`)
const dl = await call('send_to_sidecar_safe', {
  payload: { action: 'download_model', model: MODEL }
})
check('download_model 被接受', dl.ok === true && dl.r.ok === true, JSON.stringify(dl))

// 3. 进度事件
const progress = await waitFor(
  `p.status === 'model_download_progress'`,
  120000,
  'model_download_progress'
).catch((e) => {
  console.log('    ! ' + e.message)
  return []
})
check('收到 model_download_progress 事件', progress.length > 0, JSON.stringify(progress[0] ?? {}))
check(
  '进度事件带 model / percent / downloaded_bytes',
  progress[0] && typeof progress[0].percent === 'number' && typeof progress[0].downloaded_bytes === 'number',
  JSON.stringify(progress[0] ?? {})
)

// 4. 完成事件
const done = await waitFor(
  `p.status === 'model_downloaded' || p.status === 'model_download_error'`,
  300000,
  'model_downloaded'
).catch((e) => {
  console.log('    ! ' + e.message)
  return []
})
check('收到 model_downloaded 事件', done.some((e) => e.status === 'model_downloaded'), JSON.stringify(done))
if (done.some((e) => e.status === 'model_download_error')) {
  console.log('    错误: ' + JSON.stringify(done.find((e) => e.status === 'model_download_error')))
}

// 5. 落盘检查
const dir = join(TMP_ROOT, 'sherpa-onnx-paraformer-zh-small-2024-03-09')
check('模型目录已创建', existsSync(dir), dir)
if (existsSync(dir)) {
  const files = readdirSync(dir)
  console.log(`    → ${files.length} 个顶层项`)
  const total = dirSize(dir)
  check('模型体积合理（> 50MB）', total > 50 * 1024 * 1024, `${(total / 1024 / 1024).toFixed(1)} MB`)
  check('含主模型 onnx', files.some((f) => f.endsWith('.onnx')), files.slice(0, 10).join(','))
  check('含 tokens.txt', files.includes('tokens.txt'), files.slice(0, 10).join(','))
}

// 6. 状态回传：已下载
await evaluate('window.__vfEvents = []; 1')
await call('send_to_sidecar_safe', { payload: { action: 'list_models' } })
const state = await waitFor(`p.status === 'models_state'`, 30000, 'models_state').catch(() => [])
const item = state[0]?.models?.find((m) => m.name === MODEL)
check('清单里状态为 downloaded', item?.state === 'downloaded', JSON.stringify(item && { name: item.name, state: item.state }))
check('清单带主模型路径', !!item?.model_path, JSON.stringify(item && { model_path: item?.model_path }))

// 7. 删除清理
const del = await call('send_to_sidecar_safe', {
  payload: { action: 'delete_model', model: MODEL }
})
check('delete_model 成功', del.ok === true && del.r.ok === true, JSON.stringify(del))
check('模型目录已删除', !existsSync(dir), dir)

// 8. 恢复模型根
await call('send_to_sidecar_safe', {
  payload: { action: 'set_model_root', path: 'D:\\app\\ai\\VoxFlow-Portable\\data\\models' }
})
rmSync(TMP_ROOT, { recursive: true, force: true })

function dirSize(d) {
  let total = 0
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, f.name)
    if (f.isDirectory()) total += dirSize(p)
    else total += statSync(p).size
  }
  return total
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
ws.close()
process.exit(fail > 0 ? 1 : 0)
