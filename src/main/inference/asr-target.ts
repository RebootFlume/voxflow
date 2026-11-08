/**
 * ASR 模型 → 运行时文件的解析（单一事实源）。
 *
 * 与「谁来跑推理」完全无关：进程内 FFI、未来的其它适配器
 * 都从这里取路径，避免每个引擎各写一份模型名匹配规则（低耦合的落点）。
 */

import { SPECS, type ModelSpec } from '../models/spec-data'
import { activeEntryOf, mainModelFile, mmprojFile, modelDir } from '../models/model-manager'

/** 归一化：大小写不敏感 + 去掉 - 和 _（"Kokoro-v1_0" → "kokorov10"） */
function norm(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, '')
}

/**
 * 按别名查找模型描述符：精确 id/展示名 > 归一化 id/展示名 > 族前缀兜底。
 *
 * 接受前端展示名（Kokoro-v1_0）、引擎 id（kokoro-v1_0）、引擎目录名。
 * 族前缀是最低优先级的兜底（唯一性由模型清单保证）。
 */
export function findAsrModelSpec(input: string): ModelSpec | undefined {
  for (const m of SPECS) if (m.id === input || m.name === input) return m
  const ni = norm(input)
  const exact = SPECS.find((m) => norm(m.id) === ni || norm(m.name) === ni)
  if (exact) return exact
  const prefix = input.split(/[^a-zA-Z0-9]/)[0]?.toLowerCase() ?? ''
  if (prefix === '') return undefined
  return SPECS.find((m) => norm(m.id).startsWith(prefix))
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
