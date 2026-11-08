/**
 * audio.cpp FFI 引擎的主进程侧代理（目前只有 TTS）。
 *
 * 通用部分（拉进程 / 编号 / 应答配对 / 阶段转发）在 `ffi-worker/host.ts`，
 * 这里只负责「audio.cpp 特有的命令」与状态记账。
 */

import { FfiWorkerHost } from '../ffi-worker/host'
import type { AsrStageCallback } from '../engine'
import type { LoadTtsRequest, SynthesizeReply, SynthesizeRequest } from './protocol'

/** TTS 代理：worker 里跑 audio.cpp 会话 */
export class AudiocppTtsHost extends FfiWorkerHost {
  private loaded = false
  private model = ''
  private loadedFamily = ''

  constructor() {
    super({ workerFile: 'audiocpp-tts-worker.js', label: 'audiocpp-tts' })
  }

  /** 加载模型（模型路径由调用方解析好） */
  async load(req: LoadTtsRequest, onStage?: AsrStageCallback): Promise<void> {
    if (onStage) this.setStageListener(onStage)
    await this.request<void>('load', req)
    this.loaded = true
    this.model = req.modelPath
    this.loadedFamily = req.familyHint
  }

  /** 卸载模型（保留 worker 进程） */
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

  /** 合成一段文本 */
  async synthesize(req: SynthesizeRequest): Promise<SynthesizeReply> {
    return await this.request<SynthesizeReply>('synthesize', req)
  }

  isLoaded(): boolean {
    return this.loaded
  }

  modelName(): string | null {
    return this.loaded ? this.model : null
  }

  family(): string {
    return this.loadedFamily
  }

  override killForExit(): void {
    super.killForExit()
    this.resetState()
  }

  private resetState(): void {
    this.loaded = false
    this.model = ''
    this.loadedFamily = ''
  }
}
