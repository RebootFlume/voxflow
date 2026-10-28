/**
 * ArgSpec 解释器：模型描述符 → CLI argv（无模型分支）
 * —— 对齐 Rust 版 `src-tauri/src/tts/engine/argv.rs`。
 *
 * 解释器遍历 `SherpaTtsSpec.cli`（`ArgSpec[]`）拼 argv，顺序 = 描述符声明顺序。
 * 路径类参数相对「模型目录」；`modelsRootFile` 相对「models 根目录」。
 */

import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { ArgSpec } from '../models/spec-data'

/** 解释器运行时环境（合成时按当前状态填充） */
export interface ArgEnv {
  /** 模型目录（models_root / spec.id） */
  modelDir: string
  /** models 根目录（modelsRootFile 用） */
  modelsRoot: string
  /** 推理提供者（"cpu" / "cuda"） */
  provider: string
  /** 推理线程数 */
  numThreads: number
  /** 说话人 id（--sid） */
  sid: number
  /** 语言（--lang，Supertonic） */
  language: string
  /** 输出文件路径（--output-filename） */
  output: string
  /** 语音克隆参考音频（--reference-audio） */
  referenceAudio: string | null
  /** 语音克隆参考文本（--reference-text） */
  referenceText: string | null
}

/**
 * 主模型文件解析：model.onnx 优先，回退 model-steps-*.onnx 取最大（Matcha 官方包）。
 */
export function mainModelFile(dir: string): string {
  const standard = join(dir, 'model.onnx')
  if (existsSync(standard)) return standard
  try {
    const steps = readdirSync(dir)
      .filter((name) => {
        const lower = name.toLowerCase()
        return lower.startsWith('model-steps-') && lower.endsWith('.onnx')
      })
      .map((name) => join(dir, name))
      .sort((a, b) => {
        const sa = statSync(a).size
        const sb = statSync(b).size
        return sa - sb
      })
    if (steps.length > 0) return steps[steps.length - 1]
  } catch {
    // 目录不可读 → 回退标准路径
  }
  return standard
}

/**
 * 描述符声明"必须存在"的文件里，当前磁盘上缺失的（返回人话名字，用于加载/合成前预检）。
 *
 * 覆盖三处来源：`requiredFiles`、`file`（相对模型目录）、`modelsRootFile`（相对 models 根）。
 * `optionalFile` / `joinableFiles` 的语义本来就是"没有就不加参数"，不在检查范围。
 *
 * 为什么要它：sherpa-onnx 自己的配置校验只给一句 `Errors in config!`，
 * 由这里提前说清缺的是哪个文件。
 */
export function missingFiles(
  requiredFiles: readonly string[],
  cli: readonly ArgSpec[],
  env: ArgEnv
): string[] {
  const out: string[] = []
  // 用 `exists()` 而非 `isFile()`：描述符里的路径**可以指向目录**
  //（Kokoro / ZipVoice 的 `espeak-ng-data` 就是目录）——用 isFile() 会把存在的目录误判成缺失。
  for (const f of requiredFiles) {
    if (!existsSync(join(env.modelDir, f))) out.push(f)
  }
  for (const arg of cli) {
    if (arg.type === 'file' && !existsSync(join(env.modelDir, arg.value))) {
      out.push(arg.value)
    } else if (arg.type === 'modelsRootFile' && !existsSync(join(env.modelsRoot, arg.value))) {
      out.push(`${arg.value}（模型公共文件，需随模型一起下载）`)
    }
  }
  out.sort()
  return [...new Set(out)]
}

/** 描述符 → argv（模型专用参数；`--output-filename` 与 text 由调用方追加） */
export function buildArgv(cli: readonly ArgSpec[], env: ArgEnv): string[] {
  const args: string[] = []
  for (const arg of cli) {
    switch (arg.type) {
      case 'static':
        args.push(`${arg.flag}=${arg.value}`)
        break
      case 'file':
        args.push(`${arg.flag}=${join(env.modelDir, arg.value)}`)
        break
      case 'optionalFile': {
        const p = join(env.modelDir, arg.value)
        if (existsSync(p)) args.push(`${arg.flag}=${p}`)
        break
      }
      case 'joinableFiles': {
        const joined = arg.candidates
          .filter((r) => existsSync(join(env.modelDir, r)))
          .map((r) => join(env.modelDir, r))
        if (joined.length > 0) args.push(`${arg.flag}=${joined.join(arg.sep)}`)
        break
      }
      case 'modelsRootFile':
        args.push(`${arg.flag}=${join(env.modelsRoot, arg.value)}`)
        break
      case 'runtimeVar': {
        let val: string | null = null
        switch (arg.key) {
          case 'speakerId':
            val = String(env.sid)
            break
          case 'language':
            val = env.language
            break
          case 'provider':
            val = env.provider
            break
          case 'numThreads':
            val = String(env.numThreads)
            break
          case 'outputPath':
            val = env.output
            break
          case 'referenceAudio':
            val = env.referenceAudio
            break
          case 'referenceText':
            val = env.referenceText
            break
          case 'mainModelFile':
            val = mainModelFile(env.modelDir)
            break
        }
        if (val === null) continue
        args.push(`${arg.flag}=${val}`)
        break
      }
    }
  }
  return args
}
