/**
 * 进程内 FFI 引擎的 AsrEngine 适配器。
 *
 * 这是「引擎语义」与「实现细节」的边界：上层（registry / 热键 / 文件转写）
 * 只认 AsrEngine，不关心底下是子进程 HTTP 还是进程内 FFI。
 */

import { statSync } from 'node:fs'
import type { AsrEngine, AsrStageCallback } from '../engine'
import { resolveAsrModelFiles } from '../asr-target'
import { estimateVramMb, readGgufKvGeometry } from '../gguf-vram'
import { llamaRuntimeDir } from '../runtime-paths'
import { LlamaFfiHost } from './host'

/** 推理上下文长度（与历史实现保持一致，避免换引擎后行为漂移） */
const DEFAULT_CTX_SIZE = 2048

/**
 * gguf 框架的 ASR 引擎（llama.cpp 进程内 FFI）。
 *
 * 构造时注入 host，便于测试替换；默认用全局单例。
 */
export class LlamaFfiAdapter implements AsrEngine {
  private readonly host: LlamaFfiHost
  /** 当前加载的模型名（显示用，不是路径） */
  private modelName = ''

  constructor(host: LlamaFfiHost = new LlamaFfiHost()) {
    this.host = host
  }

  framework(): string {
    return 'gguf'
  }

  async loadModel(name: string): Promise<void> {
    await this.loadModelWithStageAndDevice(name, 'cuda', () => {})
  }

  async loadModelWithDevice(name: string, device: string): Promise<void> {
    await this.loadModelWithStageAndDevice(name, device, () => {})
  }

  async loadModelWithStage(name: string, onStage: AsrStageCallback): Promise<void> {
    await this.loadModelWithStageAndDevice(name, 'cuda', onStage)
  }

  async loadModelWithStageAndDevice(
    name: string,
    device: string,
    onStage: AsrStageCallback
  ): Promise<void> {
    const files = resolveAsrModelFiles(name)
    await this.host.load(
      {
        name,
        libsDir: llamaRuntimeDir(),
        modelPath: files.modelPath,
        mmprojPath: files.mmprojPath,
        device: device === 'cpu' ? 'cpu' : 'cuda',
        ctxSize: DEFAULT_CTX_SIZE
      },
      onStage
    )
    this.modelName = name
  }

  async unload(): Promise<void> {
    await this.host.unload()
    this.modelName = ''
  }

  isLoaded(): boolean {
    return this.host.isLoaded()
  }

  currentModel(): string {
    return this.modelName
  }

  async transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
    return await this.host.transcribe(samples, sampleRate, '')
  }

  async transcribeWithContext(
    samples: Float32Array,
    sampleRate: number,
    ctx: string
  ): Promise<string> {
    return await this.host.transcribe(samples, sampleRate, ctx)
  }

  /** 显存预估（权重 + mmproj + KV + 固定开销） */
  vramEstimateMb(): number | null {
    if (!this.modelName) return null
    try {
      const files = resolveAsrModelFiles(this.modelName)
      const weights = statSync(files.modelPath).size
      const mmproj = files.mmprojPath ? statSync(files.mmprojPath).size : 0
      const geom = readGgufKvGeometry(files.modelPath)
      return estimateVramMb(weights, mmproj, geom, DEFAULT_CTX_SIZE)
    } catch {
      return null
    }
  }

  /**
   * 引擎**自报**的显存占用（MiB）——真值来源。
   *
   * 优先于估算值：进程内 FFI 引擎能读设备显存的加载前后差值，直接回答
   * "我占了多少显存"，不必去查别的进程。
   */
  vramSelfReportedMb(): number | null {
    return this.host.vramMb()
  }

  /** worker 进程 PID（显存监控按 PID 取真值） */
  pid(): number | null {
    return this.host.pid()
  }

  /** 退出路径：同步杀掉 worker */
  killForExit(): void {
    this.host.killForExit()
    this.modelName = ''
  }
}
