/**
 * sherpa-onnx TTS 描述符 → C API 配置（主进程侧解析）。
 *
 * 设计要点：
 * - 描述符里的 `cli: ArgSpec[]` **同时**是「C 结构体的字段声明」：
 *   `--kokoro-model` → `model.kokoro.model`，`--matcha-acoustic-model` → `model.matcha.acoustic_model`。
 *   所以换引擎（exe → 进程内 FFI）不需要改 8 个模型的描述符，只需要换解释器。
 * - 解释器只做「字段名 + 绝对路径」的解析，不认模型名、不做模型分支。
 * - 数值型字段的默认值来自官方 CLI 的默认参数（C 结构体没有默认值，必须显式给）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ArgSpec, ModelSpec } from '../models/spec-data'
import type { TtsModelPayload } from '../inference/sherpa-ffi/protocol'
import type { SherpaTtsFamily } from '../inference/sherpa-ffi/session-tts'

/**
 * 主模型文件解析：`model.onnx` 优先，回退 `model-steps-*.onnx` 取最大（Matcha 官方包）。
 *
 * 从旧的 argv 解释器搬来 —— 现在只有 FFI 这一条合成路径需要它。
 */
export function resolveMainModelFile(dir: string): string {
  const standard = join(dir, 'model.onnx')
  if (existsSync(standard)) return standard
  let best = ''
  let bestSize = -1
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('model-steps-') || !name.endsWith('.onnx')) continue
      const size = statSync(join(dir, name)).size
      if (size > bestSize) {
        bestSize = size
        best = join(dir, name)
      }
    }
  } catch {
    // 目录不可读 → 交由调用方按空路径处理
  }
  return best
}

/** 解释器运行时环境（路径都已是绝对路径） */
export interface TtsConfigEnv {
  /** 模型目录（models_root / spec.id） */
  modelDir: string
  /** models 根目录（modelsRootFile 用） */
  modelsRoot: string
  /** 主模型文件（mainModelFile 运行时变量） */
  mainModelFile: string
}

/** C 结构体里数值字段的默认值（对齐官方 CLI 默认参数，避免 0 值导致退化合成） */
const NUMERIC_DEFAULTS: Record<SherpaTtsFamily, Record<string, number>> = {
  vits: { noise_scale: 0.667, noise_scale_w: 0.8, length_scale: 1.0 },
  matcha: { noise_scale: 0.667, length_scale: 1.0 },
  kokoro: { length_scale: 1.0 },
  kitten: { length_scale: 1.0 },
  zipvoice: { feat_scale: 0.1, t_shift: 0.5, target_rms: 0.1, guidance_scale: 1.0 },
  pocket: { voice_embedding_cache_capacity: 4 },
  supertonic: {}
}

/**
 * 把描述符里的 `--<family>-<field>` 参数名翻成 C 结构体字段名。
 *
 * 例：`--kokoro-data-dir` → `data_dir`；`--matcha-acoustic-model` → `acoustic_model`。
 */
function fieldNameOf(flag: string, family: SherpaTtsFamily): string | null {
  const prefix = `--${family}-`
  if (!flag.startsWith(prefix)) return null
  return flag.slice(prefix.length).replace(/-/g, '_')
}

/**
 * 解析 TTS 模型配置。
 *
 * @returns payload（发给 worker）+ 缺失文件清单（加载前先点名，避免 C 侧只回一句 "Errors in config!"）
 */
export function buildTtsModelPayload(
  spec: ModelSpec,
  env: TtsConfigEnv
): { payload: TtsModelPayload; missing: string[] } {
  if (spec.backend.type !== 'sherpaTts') {
    throw new Error(`${spec.name} 不是 sherpa TTS 模型`)
  }
  const family = spec.backend.family
  const fields: Record<string, string | number> = { ...NUMERIC_DEFAULTS[family] }
  const missing: string[] = []
  let ruleFsts = ''

  for (const arg of spec.backend.cli) {
    const resolved = resolveArg(arg, family, env)
    if (resolved.kind === 'field' && resolved.value !== '') {
      fields[resolved.field] = resolved.value
    } else if (resolved.kind === 'ruleFsts') {
      ruleFsts = resolved.value
    } else if (resolved.kind === 'missing') {
      missing.push(resolved.path)
    }
    // 其余（provider/numThreads/sid/language/reference*/outputPath）由会话或合成参数处理
  }

  const payload: TtsModelPayload = {
    family,
    fields,
    ruleFsts,
    ruleFars: '',
    maxNumSentences: 1,
    silenceScale: 0.2
  }
  return { payload, missing }
}

/** 单条 ArgSpec 的解释结果 */
type Resolved =
  | { kind: 'field'; field: string; value: string }
  | { kind: 'ruleFsts'; value: string }
  | { kind: 'missing'; path: string }
  | { kind: 'ignored' }

function resolveArg(arg: ArgSpec, family: SherpaTtsFamily, env: TtsConfigEnv): Resolved {
  // TTS 规则 fst：多处出现，逗号拼接（与 CLI 语义一致）
  if (arg.flag === '--tts-rule-fsts') {
    const joined = arg.type === 'joinableFiles'
      ? arg.candidates.map((c) => join(env.modelDir, c)).filter((p) => existsSync(p)).join(arg.sep)
      : ''
    return { kind: 'ruleFsts', value: joined }
  }

  if (arg.type === 'runtimeVar') {
    switch (arg.key) {
      case 'mainModelFile': {
        const field = fieldNameOf(arg.flag, family)
        if (!field) return { kind: 'ignored' }
        if (!env.mainModelFile) return { kind: 'missing', path: join(env.modelDir, 'model*.onnx') }
        return { kind: 'field', field, value: env.mainModelFile }
      }
      default:
        // provider / numThreads / sid / language / referenceAudio / referenceText / outputPath
        return { kind: 'ignored' }
    }
  }

  if (arg.type === 'joinableFiles') {
    const field = fieldNameOf(arg.flag, family)
    if (!field) return { kind: 'ignored' }
    const joined = arg.candidates
      .map((c) => join(env.modelDir, c))
      .filter((p) => existsSync(p))
      .join(arg.sep)
    return { kind: 'field', field, value: joined }
  }

  const field = fieldNameOf(arg.flag, family)
  if (!field) return { kind: 'ignored' }

  if (arg.type === 'modelsRootFile') {
    const path = join(env.modelsRoot, arg.value)
    return existsSync(path) ? { kind: 'field', field, value: path } : { kind: 'missing', path }
  }

  // file / optionalFile / static
  const path = join(env.modelDir, arg.value)
  if (arg.type === 'static') return { kind: 'field', field, value: arg.value }
  if (arg.type === 'optionalFile') {
    return existsSync(path) ? { kind: 'field', field, value: path } : { kind: 'ignored' }
  }
  return existsSync(path) ? { kind: 'field', field, value: path } : { kind: 'missing', path }
}
