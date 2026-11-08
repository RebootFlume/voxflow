/**
 * llama.cpp FFI 引擎的主进程侧代理。
 *
 * 通用部分（拉进程 / 编号 / 应答配对 / 阶段转发）在 `ffi-worker/host.ts`，
 * 这里只负责「llama 特有的命令」与状态记账。
 */

import { FfiWorkerHost } from '../ffi-worker/host'
import type { AsrStageCallback } from '../engine'
import type { LoadRequest } from './protocol'

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
export class LlamaFfiHost extends FfiWorkerHost {
  private loaded = false
  private model = ''
  private device = ''
  /** 引擎自报的显存占用（MiB）—— worker 加载时回传 */
  private selfVramMb: number | null = null

  constructor() {
    super({ workerFile: 'worker.js', label: 'llama-ffi' })
  }

  /** 加载模型（幂等：worker 内部会先释放旧模型） */
  async load(req: LoadRequest, onStage: AsrStageCallback): Promise<void> {
    this.setStageListener(onStage)
    const reply = await this.request<{ vramMb?: number | null } | null>('load', req)
    this.selfVramMb = typeof reply?.vramMb === 'number' ? reply.vramMb : null
    this.loaded = true
    this.model = req.name
    this.device = req.device
  }

  /** 卸载模型（保留 worker 进程，下次加载更快） */
  async unload(): Promise<void> {
    if (!this.pid()) {
      this.resetState()
      return
    }
    try {
      await this.request<void>('unload')
    } catch {
      // 卸载失败不阻断：worker 退出时会一并清干净
    }
    this.resetState()
  }

  /** 转写一段音频 */
  async transcribe(pcm: Float32Array, sampleRate: number, context: string): Promise<string> {
    const text = await this.request<string>('transcribe', { pcm, sampleRate, context })
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

  /** 引擎自报的显存占用（MiB）；没有自报数据 → null */
  vramMb(): number | null {
    return this.selfVramMb
  }

  /** 状态快照 */
  snapshot(): LlamaSnapshot {
    return { loaded: this.loaded, model: this.model, device: this.device }
  }

  /** 退出路径：同步杀掉 worker（不等协议握手） */
  override killForExit(): void {
    super.killForExit()
    this.resetState()
  }

  private resetState(): void {
    this.loaded = false
    this.model = ''
    this.device = ''
    this.selfVramMb = null
  }
}
