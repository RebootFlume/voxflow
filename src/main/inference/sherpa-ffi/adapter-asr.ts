/**
 * sherpa-onnx（onnx 框架）的 AsrEngine 适配器。
 *
 * 职责边界：把「模型名」翻译成「worker 需要的绝对路径配置」，
 * 其余（推理、进程生命周期）分别由 session / host 负责。
 */

import { cpus } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AsrEngine, AsrStageCallback } from '../engine'
import { findAsrModelSpec } from '../asr-target'
import { mainModelFile, modelDir } from '../../models/model-manager'
import { sherpaRuntimeDir } from '../runtime-paths'
import { SherpaAsrHost } from './host'
import type { LoadAsrRequest } from './protocol'
import type { SherpaAsrFamily } from './session-asr'

/** 推理线程数：sherpa 的 onnx 模型在 CPU 上按线程数加速，取物理核的一半避免抢占 */
function defaultThreads(): number {
  return Math.max(1, Math.floor(cpus().length / 2))
}

/**
 * onnx 框架的 ASR 引擎（sherpa-onnx 进程内 FFI）。
 *
 * 构造时注入 host，便于测试替换；默认用全局单例。
 */
export class SherpaFfiAdapter implements AsrEngine {
  private readonly host: SherpaAsrHost
  /** 当前加载的模型名（显示用，不是路径） */
  private modelName = ''

  constructor(host: SherpaAsrHost = new SherpaAsrHost()) {
    this.host = host
  }

  framework(): string {
    return 'onnx'
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
    const req = this.requestFor(name, device)
    await this.host.load(req, onStage)
    this.modelName = name
  }

  private requestFor(name: string, device: string): LoadAsrRequest {
    const spec = findAsrModelSpec(name)
    if (!spec) throw new Error(`未知 ASR 模型: ${name}`)
    if (spec.backend.type !== 'sherpaAsr') {
      throw new Error(`${name} 不是 sherpa-onnx ASR 模型`)
    }
    const dir = modelDir(name)
    if (!existsSync(dir)) throw new Error(`模型 ${name} 目录不存在: ${dir}`)
    const modelPath = mainModelFile(spec, dir)
    if (!modelPath) throw new Error(`模型 ${name} 缺少 ONNX 文件`)
    const tokensPath = join(dir, 'tokens.txt')
    if (!existsSync(tokensPath)) throw new Error(`模型 ${name} 缺少 tokens.txt`)

    return {
      runtimeDir: sherpaRuntimeDir(),
      family: spec.backend.family as SherpaAsrFamily,
      modelPath,
      tokensPath,
      provider: device.trim().toLowerCase() === 'cpu' ? 'cpu' : 'cuda',
      numThreads: defaultThreads(),
      language: spec.backend.language ?? '',
      useItn: true
    }
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
    return await this.host.transcribe(samples, sampleRate)
  }

  async transcribeWithContext(
    samples: Float32Array,
    sampleRate: number,
    _ctx: string
  ): Promise<string> {
    // sherpa 无上下文能力：行为与改动前一致
    return await this.host.transcribe(samples, sampleRate)
  }

  vramEstimateMb(): number | null {
    // onnx 引擎不暴露设备显存口径（与改动前一致返回 null）
    return null
  }

  /** worker 进程 PID（显存监控按 PID 归因） */
  pid(): number | null {
    return this.host.pid()
  }

  /** 退出路径：同步杀掉 worker */
  killForExit(): void {
    this.host.killForExit()
    this.modelName = ''
  }
}
