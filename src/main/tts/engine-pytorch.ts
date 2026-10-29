/**
 * PyTorch TTS 引擎：把 `TtsEngine` 契约映射到 Python worker 的合成命令。
 * —— 对齐 Rust 版 `src-tauri/src/tts/engine/pytorch.rs`。
 *
 * 与 sherpa 引擎的差别只在"参数怎么传"：sherpa 是命令行子进程，这里是长驻 Python worker
 * 的 JSON 命令；模型目录只提供权重与配置，G2P 与声码器都在运行时内置的适配器里。
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PyTorchWorker } from '../inference/pytorch'
import { findSpec, mainModelFile } from '../models/model-manager'
import type { ModelSpec } from '../models/spec-data'
import type { SynthAudio, TtsEngine } from './traits'

interface Inner {
  worker: PyTorchWorker | null
  spec: ModelSpec | null
  device: string
  modelDir: string
  language: string
  defaultVoice: string
}

/** 读 WAV 的 16bit PCM（worker 直接写出 WAV） */
export function readWavI16(path: string): Int16Array {
  const buf = readFileSync(path)
  // 定位 data chunk
  let off = 12
  let dataStart = 0
  let dataLen = 0
  let bitsPerSample = 16
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const sz = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      bitsPerSample = buf.readUInt16LE(off + 8 + 14)
    } else if (id === 'data') {
      dataStart = off + 8
      dataLen = sz
      break
    }
    off += 8 + sz
  }
  if (bitsPerSample !== 16) {
    throw new Error(`合成 WAV 位深异常: ${bitsPerSample}`)
  }
  if (dataLen === 0 || dataStart + dataLen > buf.length) {
    throw new Error('解析合成 WAV 失败: 无音频数据')
  }
  const count = Math.floor(dataLen / 2)
  const out = new Int16Array(count)
  for (let i = 0; i < count; i++) {
    out[i] = buf.readInt16LE(dataStart + i * 2)
  }
  return out
}

/** PyTorch TTS 引擎 */
export class PyTorchTtsEngine implements TtsEngine {
  private inner: Inner = {
    worker: null,
    spec: null,
    device: '',
    modelDir: '',
    language: 'zh',
    defaultVoice: ''
  }

  /** 由主模型文件路径反查描述符（registry 传的是 `main_model_file`） */
  private static specFor(modelPath: string): { spec: ModelSpec; adapter: string; language: string; voice: string } {
    const dir = dirname(modelPath)
    const name = basename(dir)
    const spec = findSpec(name)
    if (!spec) throw new Error(`无法识别 PyTorch TTS 模型目录: ${name}`)
    if (spec.kind !== 'tts') throw new Error(`${spec.name} 不是 TTS 模型`)
    if (spec.backend.type !== 'pytorch') throw new Error(`${spec.name} 不是 PyTorch 模型`)
    return {
      spec,
      adapter: spec.backend.adapter,
      language: spec.backend.language,
      voice: spec.backend.voice
    }
  }

  name(): string {
    return this.inner.spec?.id ?? ''
  }

  async load(modelPath: string, device: string): Promise<void> {
    const backend = PyTorchTtsEngine.specFor(modelPath)
    const spec = backend.spec
    const dir = dirname(modelPath)
    if (!mainModelFile(spec, dir)) {
      throw new Error(`${spec.name} 缺少主模型文件（下载未完成？）`)
    }
    if (this.inner.spec?.id === spec.id && this.inner.device === device && this.inner.worker) {
      return
    }
    if (this.inner.worker) {
      await this.inner.worker.shutdown().catch(() => {})
      this.inner.worker = null
    }
    const worker = new PyTorchWorker(device)
    try {
      await worker.loadModel(dir, backend.adapter, backend.language, backend.voice)
    } catch (e) {
      await worker.shutdown().catch(() => {})
      throw e
    }
    this.inner.worker = worker
    this.inner.spec = spec
    this.inner.device = device
    this.inner.modelDir = dir
    this.inner.language = backend.language
    this.inner.defaultVoice = backend.voice
  }

  async unload(): Promise<void> {
    if (this.inner.worker) {
      await this.inner.worker.shutdown().catch(() => {})
      this.inner.worker = null
    }
    this.inner.spec = null
    this.inner.device = ''
    this.inner.modelDir = ''
  }

  isLoaded(): boolean {
    return this.inner.worker !== null && this.inner.worker.isRunning()
  }

  async setLanguage(language: string): Promise<void> {
    const want = language.trim().toLowerCase()
    if (!this.inner.language || want === this.inner.language) return
    // 单语模型：明确拒绝而不是静默按别的语言合成
    throw new Error(`当前 PyTorch TTS 模型只支持 ${this.inner.language}`)
  }

  async synthesize(text: string, voice: string): Promise<SynthAudio> {
    const worker = this.inner.worker
    if (!worker) throw new Error('PyTorch TTS 模型未加载')
    // 音色：显式指定且模型目录里有该音色 → 用它；否则回落描述符默认音色
    const picked =
      voice.trim() && existsSync(join(this.inner.modelDir, 'voices', `${voice.trim()}.pt`))
        ? voice.trim()
        : this.inner.defaultVoice

    const out = join(
      tmpdir(),
      `voxflow-kokoro-${process.pid}-${Date.now()}.wav`
    )
    const options = { voice: picked, speed: 1.0, language: this.inner.language }
    let value: Record<string, unknown>
    try {
      value = await worker.synthesize(text, out, options)
    } catch (e) {
      rmSync(out, { force: true })
      throw e
    }
    const rate = typeof value.sample_rate === 'number' ? value.sample_rate : 24000
    let samples: Int16Array
    try {
      samples = readWavI16(out)
    } finally {
      rmSync(out, { force: true })
    }
    if (samples.length === 0) throw new Error('合成结果为空')
    return { samples, sampleRate: rate }
  }

  /** 语音克隆：PyTorch 适配器不支持（白名单里没有克隆实现） */
  async setCloneVoice(): Promise<void> {
    throw new Error('当前 PyTorch TTS 模型不支持语音克隆')
  }

  clearCloneVoice(): void {
    // 无克隆参数 → no-op
  }

  vramEstimateMb(): number | null {
    if (this.inner.device !== 'cuda' || !this.inner.worker) return null
    // Kokoro 权重约 320MB + 运行时/CUDA 上下文开销
    return 320 + 600
  }
}
