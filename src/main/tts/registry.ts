/**
 * TTS 引擎注册表（路由 + 互斥，镜像 inference/registry）
 * —— 对齐 Rust 版 `src-tauri/src/tts/registry.rs`。
 *
 * - 持有引擎槽：按描述符 framework 路由，互斥（同一时间一个引擎）。
 * - 命令层只调本注册表，不感知具体框架（sherpa）。
 * - 加引擎 = 在构造函数注册一行（接口 + 引擎实现，无 if/else）。
 */

import { join } from 'node:path'
import { getModelRoot, mainModelFile, findSpec } from '../models/model-manager'
import type { ModelSpec } from '../models/spec-data'
import { SherpaTtsEngine } from './engine-sherpa'
import type { TtsEngine } from './traits'

/** TTS 引擎注册表 */
export class TtsRegistry {
  private engines = new Map<string, TtsEngine>()
  private activeFramework = ''

  constructor() {
    this.register('sherpa', new SherpaTtsEngine())
  }

  /** 注册一个引擎 */
  register(framework: string, engine: TtsEngine): void {
    this.engines.set(framework, engine)
  }

  /** 按框架取引擎 */
  engine(framework: string): TtsEngine | undefined {
    return this.engines.get(framework)
  }

  /**
   * 描述符 → 引擎注册键（路由依据）。
   * 只接受 TTS 域描述符（kind 与键都是数据）；加新框架无需改此处。
   */
  private frameworkFor(spec: ModelSpec): string | null {
    return spec.kind === 'tts' ? spec.framework : null
  }

  /**
   * 加载模型（唯一权威路由）：spec 查找 → 框架 → 互斥卸载其他 → 引擎加载。
   * `model` 接受展示名 / id / 目录名（归一化，见 spec.find）。
   * 返回 (framework, model_name)。
   */
  async load(model: string, device: string): Promise<{ framework: string; model: string }> {
    const spec = findSpec(model)
    if (!spec) throw new Error(`未知模型: ${model}`)
    const framework = this.frameworkFor(spec)
    if (!framework) throw new Error(`${model} 不是 TTS 模型`)
    const engine = this.engines.get(framework)
    if (!engine) throw new Error(`框架 ${framework} 未注册`)

    // 主模型文件（models_root / spec.id / model.onnx 等）
    // 注意：**先解析再卸载**——解析失败（缺文件）时用户原来加载的模型不受影响。
    const dir = joinModelDir(spec.id)
    const mainFile = mainModelFile(spec, dir)
    if (!mainFile) throw new Error(`模型 ${spec.name} 缺少主模型文件`)

    // 互斥：先卸载其他框架的引擎
    await this.unloadOthers(framework)

    await engine.load(mainFile, device)
    this.activeFramework = framework
    return { framework, model: spec.name }
  }

  /** 卸载除指定框架外的所有引擎 */
  private async unloadOthers(keep: string): Promise<void> {
    for (const [fw, e] of this.engines) {
      if (fw === keep) continue
      if (!e.isLoaded()) continue
      try {
        await e.unload()
      } catch {
        /* 忽略单个引擎卸载失败 */
      }
      if (this.activeFramework === fw) this.activeFramework = ''
    }
  }

  /** 卸载当前引擎（未加载则 no-op） */
  async unload(): Promise<void> {
    const e = this.active()
    if (!e) return
    await e.unload()
    this.activeFramework = ''
  }

  /** 当前引擎是否已加载 */
  isLoaded(): boolean {
    return this.active() !== undefined
  }

  /** 当前加载的模型名（空 = 未加载） */
  loadedModel(): string {
    return this.active()?.name() ?? ''
  }

  /** 当前加载的框架标识（"sherpa" / 空） */
  activeFrameworkName(): string {
    return this.activeFramework
  }

  /** 当前引擎（调用方直接调接口方法；未加载返回 undefined） */
  active(): TtsEngine | undefined {
    return this.activeFramework ? this.engines.get(this.activeFramework) : undefined
  }

  /** 显存估算（MB） */
  vramMb(): number | null {
    return this.active()?.vramEstimateMb() ?? null
  }

  /** 退出路径：同步终止所有引擎的子进程（异步 unload 在退出时等不及） */
  killForExit(): void {
    for (const engine of this.engines.values()) {
      try {
        engine.killForExit?.()
      } catch {
        /* 已退出 */
      }
    }
  }

  /** 模型目录（供 speakers.json 等按 spec 读取） */
  modelDir(specId: string): string {
    return joinModelDir(specId)
  }
}

/** 模型目录 = models 根 / spec.id */
function joinModelDir(specId: string): string {
  return join(getModelRoot(), specId)
}

let registry: TtsRegistry | null = null

/** 获取全局 TTS 引擎注册表 */
export function ttsRegistry(): TtsRegistry {
  if (!registry) registry = new TtsRegistry()
  return registry
}
