/**
 * sherpa-onnx websocket server ASR 引擎
 * —— 对齐 Rust 版 `src-tauri/src/inference/sherpa_asr.rs`。
 *
 * 架构：启动 `sherpa-onnx-offline-websocket-server.exe` 子进程，
 * 通过 websocket 送 PCM（二进制帧）取回识别文本。
 *
 * 与 llama-server 的差别只在"怎么送音频"：llama 走 HTTP multipart，
 * sherpa 走 websocket 二进制帧（int32 sample_rate + int32 byte_size + float32 samples）。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import { log } from '../core/logger'
import { findSpec, mainModelFile, modelDir } from '../models/model-manager'
import { sherpaExe } from './runtime-paths'
import { findFreePort, killPortOwner, portServing, waitPortClosed, PROBE_TIMEOUT } from './device'
import type { AsrEngine, AsrStageCallback } from './engine'

const SHERPA_WS_EXE = 'sherpa-onnx-offline-websocket-server.exe'
const DEFAULT_PORT = 9002
const READY_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500

/** 引擎状态 */
type SherpaState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

/** 引擎状态快照 */
export interface SherpaSnapshot {
  loaded: boolean
  model: string
  device: string
}

/** 主模型 CLI flag（描述符驱动：--sense-voice-model / --paraformer；无模型名嗅探） */
export function mainModelFlag(modelName: string): string {
  const spec = findSpec(modelName)
  if (!spec) throw new Error(`未知 ASR 模型: ${modelName}`)
  if (spec.backend.type !== 'sherpaWs') {
    throw new Error(`${modelName} 不是 sherpa-onnx ASR 模型`)
  }
  return spec.backend.flag
}

/** 解析 sherpa 返回的 JSON，提取 text 字段 */
export function parseResult(raw: string): string {
  let v: Record<string, unknown>
  try {
    v = JSON.parse(raw) as Record<string, unknown>
  } catch (e) {
    throw new Error(`转写结果解析失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  const text = typeof v.text === 'string' ? v.text.trim() : ''
  if (!text) throw new Error('转写结果为空')
  return text
}

interface Inner {
  state: SherpaState
  child: ChildProcess | null
  port: number
  model: string
  modelDir: string
  device: string
}

/** sherpa-onnx ASR 引擎 */
export class SherpaAsrEngine {
  private inner: Inner = {
    state: { kind: 'idle' },
    child: null,
    port: DEFAULT_PORT,
    model: '',
    modelDir: '',
    device: ''
  }

  /** 引擎是否"已加载"（所有权语义） */
  isLoaded(): boolean {
    return this.inner.state.kind === 'ready'
  }

  /** 当前模型名 */
  model(): string {
    return this.inner.model
  }

  /** 当前设备 */
  device(): string {
    return this.inner.device
  }

  /** 子进程 PID */
  pid(): number | null {
    const child = this.inner.child
    if (!child || child.exitCode !== null) return null
    return child.pid ?? null
  }

  /** 状态快照 */
  snapshot(): SherpaSnapshot {
    return {
      loaded: this.isLoaded(),
      model: this.inner.model,
      device: this.inner.device
    }
  }

  /** 引擎 exe 路径 */
  static serverExe(): string {
    return sherpaExe(SHERPA_WS_EXE)
  }

  /**
   * 加载模型：启动 websocket server 子进程。
   * `device`: "cuda" → --provider=cuda；"cpu" → --provider=cpu
   */
  async load(modelName: string, device: string): Promise<void> {
    const dev = device.toLowerCase()
    // 幂等：已加载同一模型且同一设备
    if (this.isLoaded() && this.inner.model === modelName && this.inner.device === dev) {
      return
    }
    // 先停旧进程
    this.unloadLocked()

    const spec = findSpec(modelName)
    if (!spec) throw new Error(`unknown model: ${modelName}`)
    if (spec.backend.type !== 'sherpaWs') {
      throw new Error(`${modelName} 不是 sherpa 模型`)
    }
    const dir = modelDir(modelName)
    if (!existsSync(dir)) {
      throw new Error(`模型 ${modelName} 目录不存在: ${dir}`)
    }
    // 找主 onnx 文件 + tokens.txt
    const mainFile = mainModelFile(spec, dir)
    if (!mainFile) throw new Error(`模型 ${modelName} 缺少 ONNX 文件`)
    const tokens = join(dir, 'tokens.txt')
    if (!existsSync(tokens)) {
      throw new Error(`模型 ${modelName} 缺少 tokens.txt`)
    }

    const exe = SherpaAsrEngine.serverExe()
    if (!existsSync(exe)) {
      throw new Error(`sherpa server 未找到: ${exe}`)
    }

    // 清端口残留：死会话留下的孤儿 sherpa 服务器占着 9002 会让"端口通=就绪"假命中。
    await killPortOwner(DEFAULT_PORT)
    await waitPortClosed(DEFAULT_PORT, 3000)
    // 外部进程（非本软件引擎，路径判定拒杀）仍占用 → 不杀，自动换空闲端口
    let port = DEFAULT_PORT
    if (await portServing(DEFAULT_PORT, PROBE_TIMEOUT)) {
      const free = await findFreePort(DEFAULT_PORT + 1)
      if (free === null) {
        throw new Error(`端口 ${DEFAULT_PORT} 被外部进程占用且无空闲端口可用`)
      }
      log.warn(`[sherpa] 端口 ${DEFAULT_PORT} 被外部进程占用（不误杀），改用空闲端口 ${free}`)
      port = free
    }

    // 主模型 flag 由描述符决定（--sense-voice-model / --paraformer，无模型名嗅探）
    const flag = mainModelFlag(modelName)
    const args = [
      `${flag}=${mainFile}`,
      `--tokens=${tokens}`,
      // 设备生效：cpu → --provider=cpu；其他（cuda 等）→ --provider=cuda
      dev.trim() === 'cpu' ? '--provider=cpu' : '--provider=cuda',
      `--port=${port}`
    ]

    this.inner.state = { kind: 'loading' }
    const child = spawn(exe, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore']
    })
    this.inner.child = child
    this.inner.port = port
    this.inner.model = modelName
    this.inner.modelDir = dir

    // 等待就绪（最多 30s）：必须是「我们 spawn 的子进程还活着」且「端口可连」，
    // 防止外部 TCP 服务抢先占口造成的"假就绪"。
    const deadline = Date.now() + READY_TIMEOUT_MS
    for (;;) {
      if (child.exitCode !== null) {
        this.inner.state = { kind: 'error', message: 'sherpa server 进程退出' }
        throw new Error('sherpa server 启动失败：可能端口被外部进程占用，或运行库缺失')
      }
      const alive = child.exitCode === null
      if (alive && (await portServing(port, PROBE_TIMEOUT))) {
        this.inner.state = { kind: 'ready' }
        this.inner.device = dev
        return
      }
      if (Date.now() > deadline) {
        this.inner.state = { kind: 'error', message: 'sherpa server 启动超时' }
        throw new Error('sherpa server 启动超时（30s）')
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
  }

  /** 卸载（杀子进程） */
  unloadLocked(): void {
    const child = this.inner.child
    if (child) {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
    }
    this.inner.child = null
    this.inner.state = { kind: 'idle' }
    this.inner.model = ''
    this.inner.modelDir = ''
    this.inner.device = ''
  }

  /** 卸载 */
  unload(): void {
    this.unloadLocked()
  }

  /** 退出路径专用：只杀子进程，不等它退出 */
  killForExit(): void {
    this.unloadLocked()
  }

  /**
   * 转写：samples 是 16k float32 单声道 PCM。
   */
  async transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
    if (!this.isLoaded()) throw new Error('sherpa ASR 未加载')
    const port = this.inner.port

    // 连接 websocket
    const url = `ws://127.0.0.1:${port}/asr`
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', (e) => reject(new Error(`websocket 连接失败: ${e.message}`)))
    })

    try {
      // 构建二进制帧：int32 sample_rate + int32 byte_size + float32 samples
      const payload = Buffer.alloc(8 + samples.length * 4)
      payload.writeInt32LE(sampleRate, 0)
      payload.writeInt32LE(samples.length * 4, 4)
      for (let i = 0; i < samples.length; i++) {
        payload.writeFloatLE(samples[i], 8 + i * 4)
      }
      ws.send(payload, { binary: true })

      // 等结果（服务器解码完会回文本帧）
      const result = await new Promise<string>((resolve, reject) => {
        ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
          if (isBinary) return
          const text = data.toString()
          // 收到结果后发 Done 收尾
          try {
            ws.send('Done')
          } catch {
            /* 连接可能已关 */
          }
          resolve(text)
        })
        ws.on('error', (e) => reject(new Error(`websocket 读取失败: ${e.message}`)))
        ws.on('close', () => reject(new Error('websocket 连接被关闭（未收到结果）')))
      })

      return parseResult(result)
    } finally {
      try {
        ws.close()
      } catch {
        /* 已关闭 */
      }
    }
  }
}

/** 全局单例 */
let globalEngine: SherpaAsrEngine | null = null

export function globalSherpaEngine(): SherpaAsrEngine {
  if (!globalEngine) globalEngine = new SherpaAsrEngine()
  return globalEngine
}

/** sherpa-onnx 的 AsrEngine 适配：包装全局单例，供 registry 统一路由。 */
export class SherpaAsrAdapter implements AsrEngine {
  private engine = globalSherpaEngine()

  framework(): string {
    return 'onnx'
  }

  async loadModel(name: string): Promise<void> {
    await this.load(name, 'cuda')
  }

  async loadModelWithDevice(name: string, device: string): Promise<void> {
    await this.load(name, device)
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

  private async load(name: string, device: string, onStage?: AsrStageCallback): Promise<void> {
    onStage?.('loading')
    await this.engine.load(name, device)
    onStage?.('ready')
  }

  async unload(): Promise<void> {
    this.engine.unload()
  }

  isLoaded(): boolean {
    return this.engine.isLoaded()
  }

  currentModel(): string {
    return this.engine.model()
  }

  async transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
    return this.engine.transcribe(samples, sampleRate)
  }

  async transcribeWithContext(
    samples: Float32Array,
    sampleRate: number,
    _ctx: string
  ): Promise<string> {
    // sherpa 无上下文能力：行为与改动前一致
    return this.engine.transcribe(samples, sampleRate)
  }

  vramEstimateMb(): number | null {
    // 无权限时回退 None（与 Rust 版一致）
    return null
  }

  pid(): number | null {
    return this.engine.pid()
  }
}
