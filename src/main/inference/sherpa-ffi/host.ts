/**
 * sherpa-onnx FFI 引擎的主进程侧代理（ASR / TTS 各一个）。
 *
 * 通用部分（拉进程 / 编号 / 应答配对 / 阶段转发）在 `ffi-worker/host.ts`，
 * 这里只负责「sherpa 特有的命令」与状态记账。
 */

import { FfiWorkerHost } from '../ffi-worker/host'
import type { AsrStageCallback } from '../engine'
import type {
  LoadAsrRequest,
  LoadTtsRequest,
  SynthesizeReply,
  SynthesizeRequest,
  TranscribeRequest
} from './protocol'

/** ASR 代理：worker 里跑识别器 */
export class SherpaAsrHost extends FfiWorkerHost {
  private loaded = false
  private model = ''
  private device = ''

  constructor() {
    super({ workerFile: 'sherpa-asr-worker.js', label: 'sherpa-asr' })
  }

  /** 加载模型（幂等：worker 内部会先释放旧识别器） */
  async load(req: LoadAsrRequest, onStage: AsrStageCallback): Promise<void> {
    this.setStageListener(onStage)
    await this.request<void>('load', req)
    this.loaded = true
    this.model = req.modelPath
    this.device = req.provider
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

  /** 转写一段音频 */
  async transcribe(pcm: Float32Array, sampleRate: number): Promise<string> {
    const req: TranscribeRequest = { pcm, sampleRate }
    const text = await this.request<string>('transcribe', req)
    return typeof text === 'string' ? text : ''
  }

  isLoaded(): boolean {
    return this.loaded
  }

  modelName(): string | null {
    return this.loaded ? this.model : null
  }

  /** 状态快照（model 为模型路径，displayName 由适配器补） */
  snapshot(): { loaded: boolean; model: string; device: string } {
    return { loaded: this.loaded, model: this.model, device: this.device }
  }

  override killForExit(): void {
    super.killForExit()
    this.resetState()
  }

  private resetState(): void {
    this.loaded = false
    this.model = ''
    this.device = ''
  }
}

/** TTS 代理：worker 里跑合成器 */
export class SherpaTtsHost extends FfiWorkerHost {
  private loaded = false
  private model = ''

  constructor() {
    super({ workerFile: 'sherpa-tts-worker.js', label: 'sherpa-tts' })
  }

  /** 加载模型（模型配置由调用方解析好） */
  async load(req: LoadTtsRequest, onStage?: AsrStageCallback): Promise<void> {
    if (onStage) this.setStageListener(onStage)
    await this.request<void>('load', req)
    this.loaded = true
    this.model = req.model.family
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
      // 卸载失败不阻断
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

  override killForExit(): void {
    super.killForExit()
    this.resetState()
  }

  private resetState(): void {
    this.loaded = false
    this.model = ''
  }
}
