/**
 * audio.cpp 的 AsrEngine 适配器。
 *
 * 职责边界：把「模型名 + 设备」翻译成 worker 需要的绝对路径与运行时目录，
 * 其余（推理、进程生命周期）分别由 session / host 负责。
 */

import { cpus } from 'node:os'
import { existsSync, statSync } from 'node:fs'
import type { AsrEngine, AsrStageCallback } from '../engine'
import { findAsrModelSpec } from '../asr-target'
import { mainModelFile, modelDir } from '../../models/model-manager'
import { estimateVramMb, readGgufKvGeometry } from '../gguf-vram'
import { audiocppRuntimeForDevice } from '../runtime-download'
import { getGpuInfo } from '../vram'
import { log } from '../../core/logger'
import { AudiocppAsrHost } from './host-asr'
import type { LoadAsrRequest } from './protocol'

/** 推理线程数：取物理核的一半，与其它引擎一致 */
function defaultThreads(): number {
  return Math.max(1, Math.floor(cpus().length / 2))
}

/**
 * audio.cpp 推理的 ctx 长度 —— 与 llama.cpp 的 `DEFAULT_CTX_SIZE` 同值。
 * audio.cpp 的 C 侧未暴露该参数（走它自己的默认），估算显存时按同口径取，
 * 保证「同一份权重在两个引擎下显示的占用量级一致」。
 */
const AUDIOCPP_CTX_SIZE = 2048

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

    // 单一运行时包：设备只决定后端名；没卡却选 cuda 时按 CPU 跑
    const gpu = await getGpuInfo()
    const choice = audiocppRuntimeForDevice(device, gpu.available)
    if (choice.backend === 'cpu' && device.trim().toLowerCase() !== 'cpu') {
      log.info('[audiocpp-asr] 未检测到可用的 NVIDIA GPU，回退 CPU 推理')
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

  /**
   * 显存预估（权重 + KV + 固定开销）。
   *
   * 此前直接 `return null` —— 于是 audio.cpp 的模型在显存面板上完全不出明细，
   * 用户看到的是「推理框架未加载或显存信息不可用」，即使引擎正在跑。
   *
   * 口径与 llama.cpp 完全一致（同一个 `estimateVramMb`）：audio.cpp worker 也是
   * ggml/CUDA 运行时，账目结构相同。差别只有 mmproj —— audio.cpp 的 ASR 模型
   * 是单文件自带前端的（spec 里没有 mmproj 角色），所以传 0。
   * ctx 也用 2048：audio.cpp 的 C 侧没有暴露 ctx 参数，走的是它自己的默认值。
   */
  vramEstimateMb(): number | null {
    if (!this.modelName) return null
    try {
      const spec = findAsrModelSpec(this.modelName)
      if (!spec) return null
      const dir = modelDir(this.modelName)
      const modelPath = mainModelFile(spec, dir)
      if (!modelPath) return null
      const weights = statSync(modelPath).size
      const geom = readGgufKvGeometry(modelPath)
      return estimateVramMb(weights, 0, geom, AUDIOCPP_CTX_SIZE)
    } catch {
      return null
    }
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
