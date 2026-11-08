/**
 * ASR 引擎注册表：统一路由 + 互斥
 * —— 对齐 Rust 版 `src-tauri/src/inference/registry.rs`。
 *
 * 所有 ASR 框架（llama.cpp FFI / sherpa-onnx）实现 `AsrEngine`
 * 接口后注册到这里。上层（加载模型、热键录音转写、显存监控）只依赖本模块，
 * 不感知具体框架 —— 新增框架只需「实现接口 + 注册一行」。
 *
 * 互斥规则：同一时间只有一个 ASR 引擎加载。加载新 ASR 模型前，自动卸载另一个框架的模型。
 */

import { log } from '../core/logger'
import type { AsrEngine } from './engine'
import { llamaFfiAdapter } from './llama-ffi'
import { lastRequestedModel, recordLastRequested } from './asr-request'
import { sherpaFfiAdapter } from './sherpa-ffi'
import type { ModelSpec } from '../models/spec-data'
import { findAsrModelSpec } from './asr-target'

/**
 * 按别名查找模型描述符（精确 id > 归一化 id > 归一化展示名 > 族前缀兜底）。
 *
 * 实现放在 `asr-target.ts`（模型名 → 运行时文件的解析是引擎无关的），
 * 这里只是保留旧名字给现有调用方。
 */
export function findModelSpec(input: string): ModelSpec | undefined {
  return findAsrModelSpec(input)
}

/** 已注册的 ASR 引擎（顺序 = 加载优先级：gguf 主引擎在前） */
export class AsrRegistry {
  private engines = new Map<string, AsrEngine>()
  private activeFramework = ''

  constructor() {
    // gguf → llama.cpp 进程内 FFI（llama.dll + mtmd.dll，worker 子进程隔离崩溃）
    this.register('gguf', llamaFfiAdapter)
    // onnx → sherpa-onnx 进程内 FFI（sherpa-onnx-c-api.dll，worker 子进程隔离崩溃）
    this.register('onnx', sherpaFfiAdapter)
  }

  /** 注册一个引擎 */
  register(framework: string, engine: AsrEngine): void {
    this.engines.set(framework, engine)
  }

  /** 按框架取引擎 */
  engine(framework: string): AsrEngine | undefined {
    return this.engines.get(framework)
  }

  /**
   * 当前已加载的引擎（有且只有一个）。
   *
   * 为什么要多问一句 `isLoaded()`：Rust 版是**实时**按引擎 slot 算 active
   * （`src-tauri/src/inference/slot.rs:56-63`），这里存的是 `activeFramework`
   * 这个缓存字符串。两者会不一致 —— 例如 `rust_unload_sherpa_asr` 直接调引擎的
   * unload() 绕过了注册表，缓存还停在 'onnx'，于是上层（文件转写 / 对外 API /
   * 热键）以为引擎还在跑 → 跳过重新加载 → 直接报「sherpa ASR 未加载」。
   */
  activeEngine(): AsrEngine | undefined {
    const e = this.activeFramework ? this.engines.get(this.activeFramework) : undefined
    return e && e.isLoaded() ? e : undefined
  }

  /** 当前已加载的框架名（如 "gguf" / "onnx"），无则空（与 activeEngine 同一口径） */
  activeFrameworkName(): string {
    return this.activeEngine() ? this.activeFramework : ''
  }

  /** 按模型名解析引擎注册键（模型存在性 + kind 校验） */
  frameworkForModel(name: string): string {
    const spec = findModelSpec(name)
    if (!spec) throw new Error(`未知模型: ${name}`)
    if (spec.kind !== 'asr') throw new Error(`${name} 不是 ASR 模型`)
    return spec.framework
  }

  /**
   * 按模型名加载 ASR（唯一权威路由：查注册表 → 互斥 → 引擎加载）。
   * 所有入口（UI 切换 / 热键兜底 / 文件转写 / API）都走这里，保证互斥不被绕过。
   */
  async loadAsrByName(
    name: string,
    device: string,
    onStage: (stage: string) => void
  ): Promise<{ framework: string; model: string }> {
    const fw = this.frameworkForModel(name)
    const out = await this.loadModelWithStage(fw, name, device, onStage)
    // 只在**成功后**记录「最近请求」（兜底加载跟随用户当前选择）。
    // 失败不记录：否则热键/文件/API 兜底会反复重试同一个装不上的模型（每次都等满超时）。
    recordLastRequested(name, device)
    return out
  }

  /** 加载「最近一次被请求」的 ASR 模型（注册表路由，保证互斥）——热键/文件/API 兜底用 */
  async loadRequestedAsr(onStage: (stage: string) => void): Promise<{ framework: string; model: string }> {
    const { name, device } = lastRequestedModel() ?? { name: 'Qwen3-ASR-0.6B', device: 'cuda' }
    return this.loadAsrByName(name, device, onStage)
  }

  /** 统一加载：卸载其他框架的引擎，再加载指定框架的模型 */
  async loadModel(framework: string, name: string): Promise<{ framework: string; model: string }> {
    return this.loadModelWithDevice(framework, name, 'cuda')
  }

  /** 带设备加载（cpu / cuda） */
  async loadModelWithDevice(
    framework: string,
    name: string,
    device: string
  ): Promise<{ framework: string; model: string }> {
    return this.loadModelWithStage(framework, name, device, () => {})
  }

  /**
   * 带阶段回调的加载（驱动前端进度条）。
   *
   * 注意：不做注册表层的「已加载同模型」短路 —— 模型名相同但设备/参数可能不同，
   * 幂等与身份验证交给引擎层。注册表只负责互斥与路由。
   */
  async loadModelWithStage(
    framework: string,
    name: string,
    device: string,
    onStage: (stage: string) => void
  ): Promise<{ framework: string; model: string }> {
    const engine = this.engine(framework)
    if (!engine) throw new Error(`未知框架: ${framework}`)

    // 加载失败回滚用：**卸载前**记下正在服务的模型。
    const prev = this.activeEngine() ? { framework: this.activeFramework, model: this.activeEngine()!.currentModel() } : null

    // 互斥：先卸载其他框架（stage 带出被卸载的模型名，卸载前上报）
    for (const [fw, e] of this.engines) {
      if (fw === framework) continue
      if (!e.isLoaded()) continue
      const victim = e.currentModel()
      onStage(victim ? `unload:${victim}` : 'unload')
      try {
        await e.unload()
      } catch (err) {
        log.warn(`[registry] 卸载 ${fw} 失败: ${String(err)}`)
      }
      if (this.activeFramework === fw) this.activeFramework = ''
    }

    try {
      await engine.loadModelWithStageAndDevice(name, device, onStage)
      this.activeFramework = framework
      return { framework: engine.framework(), model: engine.currentModel() }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      throw new Error(await this.rollbackFailedLoad(prev, name, device, err))
    }
  }

  /**
   * 加载失败回滚：把加载前能用的模型装回来（best-effort），并把结果并入错误信息。
   *
   * 为什么必须做：同域切换是「先卸旧 → 再装新」，新模型因显存/驱动起不来时，
   * 用户**原来能用的模型也会消失**。
   */
  private async rollbackFailedLoad(
    prev: { framework: string; model: string } | null,
    target: string,
    device: string,
    err: string
  ): Promise<string> {
    if (!prev || prev.model === target) return err
    log.warn(`[registry] ${target} 加载失败（${err}），尝试回滚到 ${prev.model}`)
    const engine = this.engine(prev.framework)
    if (!engine) return `${err}；回滚 ${prev.model} 失败：框架 ${prev.framework} 未注册`
    try {
      await engine.loadModelWithStageAndDevice(prev.model, device, () => {})
      this.activeFramework = prev.framework
      return `${err}；已回滚到 ${prev.model}`
    } catch (e) {
      return `${err}；回滚 ${prev.model} 也失败: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  /** 卸载指定框架的引擎（未加载则 no-op） */
  async unload(framework: string): Promise<void> {
    const e = this.engine(framework)
    if (!e) return
    await e.unload()
    if (this.activeFramework === framework) this.activeFramework = ''
  }

  /** 卸载当前已加载的引擎 */
  async unloadActive(): Promise<void> {
    const e = this.activeEngine()
    // 没有已加载的引擎也要把缓存清掉：否则 activeFramework 会一直停在旧框架名上，
    // 后续判断「引擎在不在跑」会被这份陈旧缓存误导（见 activeEngine 的注释）。
    if (!e) {
      this.activeFramework = ''
      return
    }
    await e.unload()
    this.activeFramework = ''
  }

  /** 当前已加载引擎的显存估算（MB） */
  activeVramMb(): number | null {
    return this.activeEngine()?.vramEstimateMb() ?? null
  }
}

let globalRegistry: AsrRegistry | null = null

/** 获取全局 ASR 引擎注册表 */
export function registry(): AsrRegistry {
  if (!globalRegistry) globalRegistry = new AsrRegistry()
  return globalRegistry
}
