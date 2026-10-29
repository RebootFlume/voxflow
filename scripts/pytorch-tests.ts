/**
 * PyTorch worker 协议与适配器的端到端测试（阶段三-c）。
 *
 * 用「假 worker.py + 真解释器」验证客户端的全部监督路径
 * （对齐 Rust 版 `pytorch.rs` 测试的做法）：
 *   握手 / 响应关联 / 非协议输出忽略 / 协议版本不符 / 超时 / 崩溃 / 错误透传
 * 以及 ASR / TTS 两个适配器在假 worker 上的完整流程。
 *
 * 运行：node scripts/run-ts-tests.mjs scripts/pytorch-tests.ts
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { PyTorchWorker, overrideRuntimeDirResolver, parseReply, probeDevice } from '../src/main/inference/pytorch'
import { PyTorchAsrAdapter } from '../src/main/inference/pytorch-asr'
import { PyTorchTtsEngine } from '../src/main/tts/engine-pytorch'
import { findSpec, setModelRoot } from '../src/main/models/model-manager'

/**
 * 造一个"已安装"的模型目录：条目声明的全部文件都要在
 * （entryInstalled 逐个核存在，缺一个就不算装好）。
 */
function makeInstalledModel(modelsRoot: string, specId: string): string {
  const spec = findSpec(specId)
  if (!spec) throw new Error(`未知模型: ${specId}`)
  const dir = join(modelsRoot, spec.id)
  mkdirSync(dir, { recursive: true })
  const entry = spec.entries[0]
  if (!entry) throw new Error(`模型 ${specId} 没有条目声明`)
  for (const f of entry.files) {
    // 条目里的文件名可含子目录（如 voices/zf_xiaobei.pt）
    const target = join(dir, f.name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'x')
  }
  return dir
}

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? undefined : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

// ── 造一个「假运行时」目录：真解释器 + 假 worker.py ────────────────────────
const STUB_WORKER = resolve('scripts/stubs/fake-worker.py')
const PYTHON_EXE = process.env.VOXFLOW_TEST_PYTHON ?? 'C:/Users/xiaoda/.local/bin/python.exe'

function makeFakeRuntime(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `voxflow-fake-${tag}-`))
  if (!existsSync(PYTHON_EXE)) {
    throw new Error(`找不到测试用 Python 解释器: ${PYTHON_EXE}（可用 VOXFLOW_TEST_PYTHON 指定）`)
  }
  copyFileSync(PYTHON_EXE, join(dir, 'python.exe'))
  copyFileSync(STUB_WORKER, join(dir, 'worker.py'))
  return dir
}

/** 用指定 FAKE_MODE 跑一段 worker 逻辑 */
async function withMode<T>(mode: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = makeFakeRuntime(mode)
  const prev = process.env.FAKE_MODE
  process.env.FAKE_MODE = mode
  overrideRuntimeDirResolver(() => dir)
  try {
    return await fn(dir)
  } finally {
    overrideRuntimeDirResolver(null)
    if (prev === undefined) delete process.env.FAKE_MODE
    else process.env.FAKE_MODE = prev
    await rmDirSafe(dir)
  }
}

/**
 * 删目录（Windows 上 python.exe 退出后文件锁可能短暂残留 ⇒ 重试几次）。
 */
async function rmDirSafe(dir: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  // 实在删不掉就留给系统清理临时目录，不让测试因此失败
}

// ── 1. 协议解析（纯函数）────────────────────────────────────────────────────
console.log('\n【协议解析】')
{
  let err = ''
  try {
    parseReply({ protocol: 2, ok: true })
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  check('协议版本不符被拒绝', err.includes('协议版本不符'), err)

  const ok = parseReply({ protocol: 1, ok: true, result: { text: 'hi' } })
  check('正常响应解析出 result', ok.ok === true && ok.result.text === 'hi', JSON.stringify(ok))

  const bad = parseReply({ protocol: 1, ok: false, error: { kind: 'not_loaded', message: 'x' } })
  check('错误响应带出 kind/message', bad.ok === false && bad.errorKind === 'not_loaded' && bad.errorMessage === 'x', JSON.stringify(bad))
}

// ── 2. worker 握手与命令 ────────────────────────────────────────────────────
console.log('\n【worker 握手】')
await withMode('ok', async () => {
  const worker = new PyTorchWorker('cpu')
  await worker.ping()
  check('ping 成功', true)
  check('进程已启动', worker.isRunning())
  check('拿到 PID', (worker.pid() ?? 0) > 0, String(worker.pid()))
  check('运行时目录指向假运行时', worker.runtimeDir().includes('voxflow-fake-'), worker.runtimeDir())

  const info = await worker.runtimeInfo()
  check('runtime_info 带齐前端契约字段',
    ['python', 'torch', 'cuda_available', 'cuda_version', 'device_count'].every((k) => k in info),
    JSON.stringify(info))
  check('runtime_info 报告 torch 版本', String(info.torch).startsWith('2.14.0'), String(info.torch))

  const loaded = await worker.loadModel('D:/fake/model', 'whisper', 'zh', '')
  check('load_model 成功', loaded.adapter === 'whisper', JSON.stringify(loaded))

  const tr = await worker.transcribe('D:/fake/a.wav', { language: 'zh', context: '' })
  check('transcribe 返回文本', typeof tr.text === 'string' && tr.text.length > 0, JSON.stringify(tr))

  await worker.shutdown()
  check('shutdown 后进程已退出', !worker.isRunning())
})

// ── 3. 错误透传 ─────────────────────────────────────────────────────────────
console.log('\n【错误透传】')
await withMode('ok', async () => {
  const worker = new PyTorchWorker('cpu')
  let err = ''
  try {
    await worker.loadModel('D:/fake/model', '不存在的适配器', 'zh', '')
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  check('worker 错误带出 kind', err.includes('unsupported_adapter'), err)
  check('worker 错误带出 message', err.includes('不存在的适配器'), err)
  await worker.shutdown()
})

// ── 4. 非协议输出被忽略 ─────────────────────────────────────────────────────
console.log('\n【非协议输出】')
await withMode('noisy', async () => {
  const worker = new PyTorchWorker('cpu')
  const info = await worker.runtimeInfo()
  check('第三方库 print 不影响响应关联', String(info.torch).startsWith('2.14.0'), JSON.stringify(info))
  await worker.shutdown()
})

// ── 5. 协议版本不符 ─────────────────────────────────────────────────────────
console.log('\n【协议版本不符】')
await withMode('bad_protocol', async () => {
  const worker = new PyTorchWorker('cpu')
  let err = ''
  try {
    await worker.ping()
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  check('协议版本不符报错', err.includes('协议版本不符'), err)
  worker.kill()
})

// ── 6. 超时 ─────────────────────────────────────────────────────────────────
console.log('\n【超时】')
await withMode('hang', async () => {
  const worker = new PyTorchWorker('cpu')
  const t0 = Date.now()
  let err = ''
  try {
    await worker.ping()
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  const elapsed = Date.now() - t0
  check('不回应时超时报错', err.includes('超时'), err)
  check('超时及时返回（< 40s）', elapsed < 40_000, `${elapsed}ms`)
  worker.kill()
})

// ── 7. worker 崩溃 ─────────────────────────────────────────────────────────
console.log('\n【worker 崩溃】')
await withMode('crash', async () => {
  const worker = new PyTorchWorker('cpu')
  let err = ''
  try {
    await worker.transcribe('D:/fake/a.wav', {})
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  check('进程退出被感知为错误', err.includes('退出'), err)
  worker.kill()
})

// ── 8. probe_device 契约 ────────────────────────────────────────────────────
console.log('\n【probe_device】')
await withMode('ok', async () => {
  const info = await probeDevice('cpu')
  check('probe_device 返回前端契约字段',
    ['python', 'torch', 'cuda_available', 'cuda_version', 'device_count'].every((k) => k in info),
    JSON.stringify(info))
  check('cuda_available 是布尔', typeof info.cuda_available === 'boolean')
  check('device_count 是数字', typeof info.device_count === 'number')
})

// ── 9. ASR 适配器 ──────────────────────────────────────────────────────────
console.log('\n【ASR 适配器】')
{
  const modelsRoot = mkdtempSync(join(tmpdir(), 'voxflow-pt-models-'))
  const prevRoot = setModelRoot(modelsRoot)
  makeInstalledModel(modelsRoot, 'whisper-tiny-pt')

  await withMode('ok', async () => {
    const adapter = new PyTorchAsrAdapter()
    eq('framework 为 pytorch', adapter.framework(), 'pytorch')
    check('未加载时 isLoaded=false', adapter.isLoaded() === false)
    check('未加载时 currentModel 为空', adapter.currentModel() === '')

    const stages: string[] = []
    await adapter.loadModelWithStageAndDevice('Whisper-tiny-PT', 'cpu', (s) => stages.push(s))
    check('加载后 isLoaded=true', adapter.isLoaded() === true)
    eq('currentModel 为展示名', adapter.currentModel(), 'Whisper-tiny-PT')
    check('阶段回调含 loading 与 ready', stages.includes('loading') && stages.includes('ready'), JSON.stringify(stages))

    const text = await adapter.transcribe(new Float32Array(1600), 16000)
    check('转写返回 worker 的文本', text.includes('假 worker'), text)

    await adapter.unload()
    check('卸载后 isLoaded=false', adapter.isLoaded() === false)
  })

  // 非 PyTorch 模型必须被拒
  await withMode('ok', async () => {
    const adapter = new PyTorchAsrAdapter()
    let err = ''
    try {
      await adapter.loadModelWithDevice('Qwen3-ASR-0.6B', 'cpu')
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    }
    check('非 PyTorch 模型被拒绝', err.includes('不是 PyTorch 模型'), err)
  })

  setModelRoot(prevRoot)
  rmSync(modelsRoot, { recursive: true, force: true })
}

// ── 10. TTS 引擎 ───────────────────────────────────────────────────────────
console.log('\n【TTS 引擎】')
{
  const modelsRoot = mkdtempSync(join(tmpdir(), 'voxflow-pt-tts-'))
  const prevRoot = setModelRoot(modelsRoot)
  const modelDir = makeInstalledModel(modelsRoot, 'kokoro-82m-pt')
  const mainFile = join(modelDir, 'model.pth')

  await withMode('ok', async () => {
    const engine = new PyTorchTtsEngine()
    check('未加载时 isLoaded=false', engine.isLoaded() === false)
    eq('未加载时 name 为空', engine.name(), '')

    await engine.load(mainFile, 'cpu')
    check('加载后 isLoaded=true', engine.isLoaded() === true)
    eq('name 为模型 id', engine.name(), 'kokoro-82m-pt')

    const audio = await engine.synthesize('你好', '')
    check('合成返回 PCM 样本', audio.samples.length === 2400, String(audio.samples.length))
    eq('合成采样率为 24000', audio.sampleRate, 24000)

    let err = ''
    try {
      await engine.setCloneVoice('D:/fake/ref.wav', '文本')
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    }
    check('PyTorch TTS 不支持克隆', err.includes('不支持语音克隆'), err)

    await engine.unload()
    check('卸载后 isLoaded=false', engine.isLoaded() === false)
  })

  setModelRoot(prevRoot)
  rmSync(modelsRoot, { recursive: true, force: true })
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
