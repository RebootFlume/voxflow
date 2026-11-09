/**
 * 预设音色表与「用户传的 voice → 具体音色」的解析 —— 唯一实现。
 *
 * 为什么需要收敛：前端对所有模型统一用 **sid（数字序号）** 标识音色，
 * 但各引擎的语义不同：
 * - sherpa-onnx 的 sid 就是 C 侧的 speaker id（Kokoro 36 个、Matcha 单音色…）；
 * - audio.cpp 的预设音色是**名字**（qwen3_tts 的 vivian / serena…），sid 只是列表序号。
 * 对外（含 OpenAI 兼容 API）调用方又习惯传**名字**。两边都得能认，且认不出要报错，
 * 不能静默用别的音色（那是最难查的一类问题）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelSpec, PresetSpec } from '../models/spec-data'

export interface SpeakerEntry {
  /** 列表序号（UI 的 sid） */
  sid: number
  /** 音色名（audio.cpp 的 voice_id / sherpa speakers.json 的 name） */
  name: string
}

/** 描述符里的预设音色定义（fixed / 仅克隆 → null） */
export function presetOf(spec: ModelSpec | null | undefined): PresetSpec | null {
  const vm = spec?.voiceMode
  if (!vm) return null
  if (vm.type === 'preset') return vm
  if (vm.type === 'presetAndClone') return vm.preset
  return null
}

/**
 * 说话人列表：内联名优先 → speakers.json → 编号兜底。
 *
 * 内联名（`speakers: string[]`）用于「音色即 voice_id」的族（audio.cpp），
 * sid 只是序号；speakers.json 用于 sherpa 的模型自带音色表。
 */
export function speakerList(dir: string, preset: PresetSpec): SpeakerEntry[] {
  if (preset.speakers && preset.speakers.length > 0) {
    return preset.speakers.map((name, i) => ({ sid: i, name }))
  }
  if (preset.speakersFile) {
    try {
      const data = readFileSync(join(dir, preset.speakersFile), 'utf-8')
      const list = JSON.parse(data) as SpeakerEntry[]
      if (Array.isArray(list) && list.length > 0) return list
    } catch {
      // 读不到就退回编号列表
    }
  }
  return Array.from({ length: preset.count }, (_, i) => ({ sid: i, name: `speaker ${i}` }))
}

/** 该模型可选的音色表（无预设音色 → null，调用方应按「不指定音色」处理） */
export function voiceListOf(spec: ModelSpec, modelDir: string): SpeakerEntry[] | null {
  const preset = presetOf(spec)
  return preset ? speakerList(modelDir, preset) : null
}

/** 归一化：大小写 + 空白 + 括号后缀（"alloy (EN)" ≈ "alloy"） */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[\s_-]/g, '')
    .trim()
}

/**
 * 把用户传的 voice 解析成具体音色条目。
 *
 * 接受：空串 / "default"（= 用模型默认，返回 null）、列表序号、音色名
 * （大小写与 "(EN)" 之类后缀不敏感）。
 *
 * 认不出时的取舍：
 * - **序号越界 → 抛错**：序号是 UI 自己写的，越界说明模型换了、配置残留，
 *   静默给个别的音色会让用户以为选择坏了（消息里带可用范围）。
 * - **名字不认识 → 返回 null（= 默认音色）**，由调用方记一行警告。不抛错是有意的：
 *   OpenAI 兼容 API 的第三方客户端通常硬编码 `voice: "alloy"`，直接 500 会让
 *   整个 /v1/audio/speech 不可用 —— 警告 + 默认音色是更可用的降级。
 */
export function resolveVoice(
  voice: string,
  list: SpeakerEntry[] | null,
  modelName: string,
  opts: { invalidNumber?: 'throw' | 'default' } = {}
): SpeakerEntry | null {
  const v = (voice ?? '').trim()
  if (!v || v.toLowerCase() === 'default') return null
  if (!list || list.length === 0) return null

  // 1) 序号（UI 的 sid）
  const asNumber = Number(v)
  if (Number.isInteger(asNumber)) {
    const hit = list.find((s) => s.sid === asNumber)
    if (hit) return hit
    if ((opts.invalidNumber ?? 'throw') === 'default') return null
    throw new Error(
      `模型 ${modelName} 没有音色序号 ${asNumber}（可用 ${list[0].sid}–${list[list.length - 1].sid}）`
    )
  }

  // 2) 名字（精确 → 归一化）
  const exact = list.find((s) => s.name === v)
  if (exact) return exact
  const loose = list.find((s) => norm(s.name) === norm(v))
  if (loose) return loose

  // 认不出名字：返回 null = 模型默认音色（调用方负责记警告）
  return null
}
