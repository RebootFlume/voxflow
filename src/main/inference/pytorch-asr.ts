/**
 * PyTorch ASR 适配器：把 `AsrEngine` 契约映射到 Python worker 的 JSON 协议。
 * —— 对齐 Rust 版 `src-tauri/src/inference/pytorch_asr.rs`。
 *
 * 职责边界：
 * - 只做"契约翻译"：模型解析（查描述符）→ 选运行时（按设备）→ 起 worker → 传 WAV 路径；
 * - 不感知具体模型架构（whisper 的加载与解码都在 worker 内的白名单适配器里）；
 * - 音频以临时 WAV 交给 worker（首版约定），避免二进制帧协议与 torchaudio 依赖。
 */

import { rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AsrEngine, AsrStageCallback } from './engine'
import { PyTorchWorker } from './pytorch'
import { findSpec, mainModelFile, modelDir } from '../models/model-manager'
import type { ModelSpec } from '../models/spec-data'

interface Inner {
  worker: PyTorchWorker | null
  model: string
  device: string
  modelDir: string
  adapter: string
  language: string
}

/** 临时 WAV 自增序号（避免并发转写互相覆盖） */
let tempSeq = 1

/** 写临时 16-bit PCM WAV（worker 侧按需线性重采样） */
export function writeTempWav(samples: Float32Array, sampleRate: number): string {
  const seq = tempSeq++
  const path = join(tmpdir(), `voxflow-pytorch-${process.pid}-${seq}.wav`)
  const dataBytes = samples.length * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(Math.max(sampleRate, 1), 24)
  header.writeUInt32LE(Math.max(sampleRate, 1) * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)

  const body = Buffer.alloc(dataBytes)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i])) * 32767
    body.writeInt16LE(Math.round(v), i * 2)
  }
  writeFileSync(path, Buffer.concat([header, body]))
  return path
}

/** 从描述符取 PyTorch 后端参数（非 PyTorch 模型 → 明确报错，不做猜测） */
export function backendOf(
  name: string
): { spec: ModelSpec; adapter: string; language: string; voice: string } {
  const spec = findSpec(name)
  if (!spec) throw new Error(`未知模型: ${name}`)
  if (spec.kind !== 'asr') throw new Error(`${name} 不是 ASR 模型`)
  if (spec.backend.type !== 'pytorch') throw new Error(`${name} 不是 PyTorch 模型`)
  return {
    spec,
    adapter: spec.backend.adapter,
    language: spec.backend.language,
    voice: spec.backend.voice
  }
}

/** PyTorch ASR 适配器 */
export class PyTorchAsrAdapter implements AsrEngine {
  private inner: Inner = {
    worker: null,
    model: '',
    device: '',
    modelDir: '',
    adapter: '',
    language: ''
  }
  /** 峰值显存估算用的最近一次加载信息 */
  private vramHintMb: number | null = null

  framework(): string {
    return 'pytorch'
  }

  private async load(name: string, device: string, onStage: AsrStageCallback): Promise<void> {
    const backend = backendOf(name)
    const spec = backend.spec
    const dir = modelDir(spec.name)
    if (!existsDir(dir)) {
      throw new Error(`模型 ${spec.name} 尚未下载: ${dir}`)
    }
    // 主权重必须存在（缺文件时给明确提示，而不是等 worker 报错）
    if (!mainModelFile(spec, dir)) {
      throw new Error(`${spec.name} 缺少主模型文件（下载未完成？）`)
    }
    onStage('loading')
    // 幂等：同模型 + 同设备直接复用（worker 内部也会判重，这里省一次 IPC）
    if (this.inner.model === spec.name && this.inner.device === device && this.inner.worker) {
      onStage('ready')
      return
    }
    // 先卸旧进程：换设备/换模型时必须释放显存与 DLL
    if (this.inner.worker) {
      await this.inner.worker.shutdown()
      this.inner.worker = null
    }
    const worker = new PyTorchWorker(device)
    try {
      await worker.loadModel(dir, backend.adapter, backend.language, '')
    } catch (e) {
      await worker.shutdown().catch(() => {})
      throw new Error(`${spec.name} 加载失败: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.inner.worker = worker
    this.inner.model = spec.name
    this.inner.device = device
    this.inner.modelDir = dir
    this.inner.adapter = backend.adapter
    this.inner.language = backend.language
    this.vramHintMb = null
    onStage('ready')
  }

  async loadModel(name: string): Promise<void> {
    await this.load(name, 'cuda', () => {})
  }

  async loadModelWithDevice(name: string, device: string): Promise<void> {
    await this.load(name, device, () => {})
  }

  async loadModelWithStage(name: string, onStage: AsrStageCallback): Promise<void> {
    await this.load(name, 'cuda', onStage)
  }

  async loadModelWithStageAndDevice(
    name: string,
    device: string,
    onStage: AsrStageCallback
  ): Promise<void> {
    await this.load(name, device, onStage)
  }

  async unload(): Promise<void> {
    if (this.inner.worker) {
      await this.inner.worker.shutdown().catch(() => {})
      this.inner.worker = null
    }
    this.inner.model = ''
    this.inner.device = ''
    this.inner.modelDir = ''
  }

  /**
   * 退出路径专用：直接杀掉 python worker 子进程（不等它退出）。
   * 只走 unload() 的话要等 worker 的 shutdown 协议应答，应用退出时经常来不及，
   * python.exe 就会变成孤儿进程继续占着显存。
   */
  killForExit(): void {
    this.inner.worker?.kill()
    this.inner.worker = null
  }

  isLoaded(): boolean {
    return this.inner.worker !== null && this.inner.worker.isRunning()
  }

  currentModel(): string {
    if (!this.inner.worker) return ''
    return this.inner.model
  }

  async transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
    return this.transcribeWithContext(samples, sampleRate, '')
  }

  async transcribeWithContext(
    samples: Float32Array,
    sampleRate: number,
    ctx: string
  ): Promise<string> {
    const worker = this.inner.worker
    if (!worker) throw new Error('PyTorch 模型未加载')
    const wav = writeTempWav(samples, sampleRate)
    const options = { language: this.inner.language, context: ctx }
    let result: Record<string, unknown>
    try {
      result = await worker.transcribe(wav, options)
    } finally {
      rmSync(wav, { force: true })
    }
    return typeof result.text === 'string' ? result.text : ''
  }

  vramEstimateMb(): number | null {
    // CPU 模式不占显存；CUDA 模式按"模型目录体积 + 运行时开销"粗估（权重常驻）
    if (this.inner.device !== 'cuda' || !this.inner.worker) return null
    if (this.vramHintMb !== null) return this.vramHintMb
    const bytes = dirSize(this.inner.modelDir)
    if (bytes === 0) return null
    const mb = Math.floor(bytes / (1024 * 1024)) + 600 // + 运行时/CUDA 上下文固定开销
    this.vramHintMb = mb
    return mb
  }

  pid(): number | null {
    return this.inner.worker?.pid() ?? null
  }
}

/** 目录体积（字节） */
function dirSize(dir: string): number {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const d = stack.pop() as string
    let entries: string[] = []
    try {
      entries = require('node:fs').readdirSync(d) as string[]
    } catch {
      continue
    }
    for (const name of entries) {
      const p = join(d, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) stack.push(p)
        else total += st.size
      } catch {
        /* 跳过不可读项 */
      }
    }
  }
  return total
}

/** 目录是否存在 */
function existsDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}
