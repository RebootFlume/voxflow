/**
 * FFI worker 的宿主侧：进程生命周期 + 请求应答。
 *
 * 这一层只关心「怎么和 worker 说话」：拉起进程、编号、匹配应答、转发阶段事件。
 * 推理怎么跑（session.ts）、命令长什么样（protocol.ts）都不归它管。
 */

import { fork, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { log } from '../../core/logger'
import type { AsrStageCallback } from '../engine'
import type { LoadRequest, WorkerCommand, WorkerCommandBody, WorkerEvent } from './protocol'

/** worker 在构建产物里的位置（与主进程入口同目录） */
function workerPath(): string {
  return join(__dirname, 'worker.js')
}

interface Pending {
  resolve: (payload: unknown) => void
  reject: (err: Error) => void
}

/** 引擎状态快照（loaded / model / device 取自同一次状态） */
export interface LlamaSnapshot {
  loaded: boolean
  model: string
  device: string
}

/**
 * 进程内 FFI 引擎的主进程侧代理。
 *
 * 生命周期：首次 load 时拉起 worker → 长期常驻 → unload 时释放模型（进程保留）。
 */
export class LlamaFfiHost {
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private loaded = false
  private model = ''
  private device = ''

  /** 拉起 worker（已存在则复用） */
  private ensureWorker(): ChildProcess {
    if (this.child && this.child.connected) return this.child
    const child = fork(workerPath(), [], {
      // Electron 进程要显式切成纯 Node 模式，否则子进程会拉起 Chromium
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [],
      // 高级序列化：PCM 用 Float32Array 传，JSON 模式会把它拍平成普通对象
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    child.on('message', (event: WorkerEvent) => this.onEvent(event))
    child.on('exit', (code, signal) => {
      log.warn(`[llama-ffi] worker 退出 code=${code} signal=${signal}`)
      this.child = null
      this.loaded = false
      this.model = ''
      this.device = ''
      this.failAll(new Error('推理 worker 已退出'))
    })
    child.on('error', (err) => {
      log.warn(`[llama-ffi] worker 错误: ${err.message}`)
    })
    // worker 的 stdout/stderr 只做诊断，不参与协议
    child.stdout?.on('data', (d: Buffer) => log.info(`[llama-ffi] ${d.toString().trimEnd()}`))
    child.stderr?.on('data', (d: Buffer) => log.info(`[llama-ffi] ${d.toString().trimEnd()}`))
    this.child = child
    return child
  }

  private onEvent(event: WorkerEvent): void {
    if (event.kind === 'stage') {
      this.onStage?.(event.stage)
      return
    }
    const pending = this.pending.get(event.id)
    if (!pending) return
    this.pending.delete(event.id)
    if (event.ok) pending.resolve(event.payload)
    else pending.reject(new Error(event.error))
  }

  /** 阶段回调（由 adapter 注入，驱动前端进度条） */
  private onStage: AsrStageCallback | null = null

  private failAll(err: Error): void {
    for (const [, pending] of this.pending) pending.reject(err)
    this.pending.clear()
  }

  /** 发一条命令并等待应答 */
  private request<T>(cmd: WorkerCommandBody): Promise<T> {
    const child = this.ensureWorker()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (payload) => resolve(payload as T),
        reject
      })
      child.send({ ...cmd, id } as WorkerCommand)
    })
  }

  /** 加载模型（幂等：worker 内部会先释放旧模型） */
  async load(req: LoadRequest, onStage: AsrStageCallback): Promise<void> {
    this.onStage = onStage
    await this.request({ kind: 'load', payload: req })
    this.loaded = true
    this.model = req.name
    this.device = req.device
  }

  /** 卸载模型（保留 worker 进程，下次加载更快） */
  async unload(): Promise<void> {
    if (!this.child) {
      this.loaded = false
      this.model = ''
      this.device = ''
      return
    }
    try {
      await this.request({ kind: 'unload' })
    } catch (err) {
      log.warn(`[llama-ffi] 卸载失败: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.loaded = false
    this.model = ''
    this.device = ''
  }

  /** 转写一段音频 */
  async transcribe(pcm: Float32Array, sampleRate: number, context: string): Promise<string> {
    const text = await this.request<string>({
      kind: 'transcribe',
      payload: { pcm, sampleRate, context }
    })
    return typeof text === 'string' ? text : ''
  }

  /** 模型是否已加载 */
  isLoaded(): boolean {
    return this.loaded
  }

  /** 当前模型路径（未加载 → null） */
  modelName(): string | null {
    return this.loaded ? this.model : null
  }

  /** 状态快照 */
  snapshot(): LlamaSnapshot {
    return { loaded: this.loaded, model: this.model, device: this.device }
  }

  /** worker 进程 PID（未拉起 → null） */
  pid(): number | null {
    return this.child?.pid ?? null
  }

  /** 退出路径：同步杀掉 worker（不等协议握手） */
  killForExit(): void {
    if (!this.child) return
    try {
      this.child.kill('SIGKILL')
    } catch {
      // 忽略：进程可能已退出
    }
    this.child = null
    this.loaded = false
    this.model = ''
    this.device = ''
  }
}
