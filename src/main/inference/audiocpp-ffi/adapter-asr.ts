/**
 * audio.cpp 的 AsrEngine 适配器。
 *
 * 职责边界：把「模型名 + 设备」翻译成 worker 需要的绝对路径与运行时目录，
 * 其余（推理、进程生命周期）分别由 session / host 负责。
 */

import { cpus } from 'node:os'
import { existsSync } from 'node:fs'
import type { AsrEngine, AsrStageCallback } from '../engine'
import { findAsrModelSpec } from '../asr-target'
import { mainModelFile, modelDir } from '../../models/model-manager'
import { audiocppRuntimeForDevice } from '../runtime-download'
import { getGpuInfo } from '../vram'
import { log } from '../../core/logger'
import { AudiocppAsrHost } from './host-asr'
import type { LoadAsrRequest } from './protocol'

/** 推理线程数：取物理核的一半，与其它引擎一致 */
function defaultThreads(): number {
  return Math.max(1, Math.floor(cpus().length / 2))
}

/** audio.cpp ASR 引擎（进程内 FFI） */
export class AudiocppAsrAdapter implements AsrEngine {
  private readonly host: AudiocppAsrHost
  /** 当前加载的模型名（显示用，不是路径） */
  private modelName = ''

  constructor(host: AudiocppAsrHost = new AudiocppAsrHost()) {
    this.host = host
  }

  framework(): string {
    return 'audio.cpp'
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
    const req = await this.requestFor(name, device)
    await this.host.load(req, onStage)
    this.modelName = name
  }

  private async requestFor(name: string, device: string): Promise<LoadAsrRequest> {
    const spec = findAsrModelSpec(name)
    if (!spec) throw new Error(`未知 ASR 模型: ${name}`)
    if (spec.backend.type !== 'audiocpp') {
      throw new Error(`${name} 不是 audio.cpp ASR 模型`)
    }
    const dir = modelDir(name)
    if (!existsSync(dir)) throw new Error(`模型 ${name} 目录不存在: ${dir}`)
    const modelPath = mainModelFile(spec, dir)
    if (!modelPath) throw new Error(`模型 ${name} 缺少 GGUF 文件`)

    // 有 GPU 才可能走 cuda：没卡却选 cuda 时按 CPU 跑（否则每个用户都会撞变体不匹配）
    const gpu = await getGpuInfo()
    const choice = audiocppRuntimeForDevice(device, gpu.available)
    if (choice.backend === 'cpu' && device.trim().toLowerCase() !== 'cpu') {
      log.info(`[audiocpp-asr] ${gpu.available ? 'CUDA 变体未安装' : '未检测到 NVIDIA GPU'}，回退 CPU 推理`)
    }

    return {
      runtimeDir: choice.dir,
      modelPath,
      familyHint: spec.backend.family,
      backend: choice.backend,
      numThreads: defaultThreads()
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
    // audio.cpp 的 ASR 请求没有「上文」入口：行为与 transcribe 一致
    return await this.host.transcribe(samples, sampleRate)
  }

  vramEstimateMb(): number | null {
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

/** 全局单例（注册表用） */
export const audiocppAsrAdapter = new AudiocppAsrAdapter()
