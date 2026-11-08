/**
 * FFI worker 的宿主侧：进程生命周期 + 请求应答（框架无关）。
 *
 * 这一层只关心「怎么和 worker 说话」：拉起进程、编号、匹配应答、转发阶段事件。
 * 推理怎么跑（各引擎的 session.ts）、命令长什么样（各引擎的 protocol.ts）都不归它管。
 *
 * 为什么要把 worker 放在子进程：原生 DLL（llama.cpp / onnxruntime）段错误会带走整个进程。
 * 放在子进程里，崩溃只影响 worker，主进程（UI）不受影响。
 */

import { fork, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { log } from '../../core/logger'
import type { AsrStage } from '../engine'
import type { WorkerCommand, WorkerEvent } from './protocol'

export interface FfiWorkerHostOptions {
  /** worker 入口文件名（与主进程构建产物同目录，如 'worker.js'） */
  workerFile: string
  /** 日志前缀（如 'llama-ffi'） */
  label: string
}

interface Pending {
  resolve: (payload: unknown) => void
  reject: (err: Error) => void
}

/**
 * 进程内 FFI 引擎的主进程侧代理（通用骨架）。
 *
 * 生命周期：首次请求时拉起 worker → 长期常驻 → 退出路径统一杀掉。
 */
export class FfiWorkerHost {
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private stageListener: ((stage: AsrStage) => void) | null = null

  constructor(private readonly options: FfiWorkerHostOptions) {}

  /** 阶段回调（由各引擎注入，驱动前端进度条） */
  setStageListener(listener: ((stage: AsrStage) => void) | null): void {
    this.stageListener = listener
  }

  /** 拉起 worker（已存在则复用） */
  private ensureWorker(): ChildProcess {
    if (this.child && this.child.connected) return this.child
    const { label, workerFile } = this.options
    const child = fork(join(__dirname, workerFile), [], {
      // Electron 进程要显式切成纯 Node 模式，否则子进程会拉起 Chromium
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [],
      // 高级序列化：PCM 用 Float32Array 传，JSON 模式会把它拍平成普通对象
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    child.on('message', (event: WorkerEvent) => this.onEvent(event))
    child.on('exit', (code, signal) => {
      log.warn(`[${label}] worker 退出 code=${code} signal=${signal}`)
      this.child = null
      this.failAll(new Error('推理 worker 已退出'))
    })
    child.on('error', (err) => {
      log.warn(`[${label}] worker 错误: ${err.message}`)
    })
    // worker 的 stdout/stderr 只做诊断，不参与协议
    child.stdout?.on('data', (d: Buffer) => log.info(`[${label}] ${d.toString().trimEnd()}`))
    child.stderr?.on('data', (d: Buffer) => log.info(`[${label}] ${d.toString().trimEnd()}`))
    this.child = child
    return child
  }

  private onEvent(event: WorkerEvent): void {
    if (event.kind === 'stage') {
      this.stageListener?.(event.stage)
      return
    }
    const pending = this.pending.get(event.id)
    if (!pending) return
    this.pending.delete(event.id)
    if (event.ok) pending.resolve(event.payload)
    else pending.reject(new Error(event.error))
  }

  private failAll(err: Error): void {
    for (const [, pending] of this.pending) pending.reject(err)
    this.pending.clear()
  }

  /** 发一条命令并等待应答 */
  request<T>(kind: string, payload?: unknown): Promise<T> {
    const child = this.ensureWorker()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      })
      const command: WorkerCommand = { id, kind, payload }
      child.send(command)
    })
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
    this.failAll(new Error('推理 worker 已退出'))
  }
}
