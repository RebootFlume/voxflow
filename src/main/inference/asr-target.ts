/**
 * ASR 模型 → 运行时文件的解析（单一事实源）。
 *
 * 与「谁来跑推理」完全无关：进程内 FFI、未来的其它适配器
 * 都从这里取路径，避免每个引擎各写一份模型名匹配规则（低耦合的落点）。
 */

import type { ModelSpec } from '../models/spec-data'
import { activeEntryOf, findSpec, mainModelFile, mmprojFile, modelDir } from '../models/model-manager'

/**
 * 按复合身份查找 ASR 模型描述符。
 *
 * 首选 `<框架层>/<目录名>`（如 `llama.cpp/qwen3-asr-0.6b`）；裸名只在**全局唯一**
 * 时命中。跨层同名（"Qwen3-ASR-0.6B" 在 llama.cpp 与 audio.cpp 各有一份）
 * 一律不猜 —— 猜错族的代价是把 A 族的描述符套到 B 族权重上。
 *
 * 不按 kind 过滤：调用方（load_model）还要靠 kind 区分 ASR / TTS 路由。
 */
export function findAsrModelSpec(input: string): ModelSpec | undefined {
  return findSpec(input)
}

/** 一个 ASR 模型的运行时文件 */
export interface AsrModelFiles {
  /** GGUF 主模型绝对路径 */
  modelPath: string
  /** mmproj（音频/视觉投影塔）绝对路径；该模型不需要时为空串 */
  mmprojPath: string
}

/**
 * 解析模型的运行时文件路径。
 *
 * 路径一律取自描述符的**精选条目**声明，不按目录里"有什么文件"来猜 ——
 * 否则同一个模型目录里残留的旧版本文件会被误当成当前条目。
 */
export function resolveAsrModelFiles(name: string): AsrModelFiles {
  const spec = findAsrModelSpec(name)
  if (!spec) throw new Error(`未知模型: ${name}`)
  if (spec.backend.type !== 'llama') {
    throw new Error(`${name} 不是 llama 后端模型（backend=${spec.backend.type}）`)
  }
  const dir = modelDir(name)
  const modelPath = mainModelFile(spec, dir)
  if (!modelPath) {
    throw new Error(`在 ${dir} 未找到主模型文件（条目 ${activeEntryOf(spec)?.id ?? '-'}）`)
  }
  return { modelPath, mmprojPath: mmprojFile(spec, dir) ?? '' }
}
