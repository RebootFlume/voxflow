/**
 * sherpa-onnx E2E TTS 引擎（子进程模式，描述符驱动）
 * —— 对齐 Rust 版 `src-tauri/src/tts/engine/sherpa.rs`。
 *
 * 架构：调用 `libs/sherpa-onnx/bin/sherpa-onnx-offline-tts.exe` 子进程合成音频，
 * 与 ASR 的 llama-server 子进程一致 —— 推理框架与桌面应用进程隔离。
 *
 * 要点：
 * - 模型差异全部收敛在 `ModelSpec` 描述符（spec-data.ts），本文件**无模型分支**。
 * - argv 由 `ArgSpec` 解释器（argv.ts）拼装。
 * - device 参数真实接线：cpu → `--provider=cpu`，其余 → `--provider=cuda`。
 * - `synthesize` 返回真实采样率，不硬编码 24k、不重采样。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { findSpec, getModelRoot } from '../models/model-manager'
import type { ModelSpec, VoiceModeSpec } from '../models/spec-data'
import { sherpaExe } from '../inference/runtime-paths'
import { buildArgv, missingFiles, type ArgEnv } from './argv'
import type { SynthAudio, TtsEngine } from './traits'

/** 引擎可变状态（&self 接口下的内部锁） */
interface SherpaInner {
  /** 当前模型描述符（null = 未加载） */
  spec: ModelSpec | null
  /** models 根目录 */
  modelRoot: string
  /** 说话人 ID（Kokoro / Supertonic 等多说话人模型） */
  sid: number
  /** 推理提供者（由 device 映射：cpu / cuda） */
  provider: string
  /** 推理线程数（CPU 模式生效） */
  numThreads: number
  /** 当前语言（Supertonic 等需 --lang 的模型使用） */
  language: string
  /** 语音克隆：参考音频路径（ZipVoice 使用） */
  referenceAudio: string | null
  /** 语音克隆：参考音频对应的文本（ZipVoice 需要） */
  referenceText: string | null
}

/**
 * 正在运行的 sherpa-tts 子进程（每次合成起一个）。
 *
 * 之前没有跟踪 → 应用在合成过程中被关掉时，子进程会变成孤儿继续跑
 * （Rust 版在退出路径上会杀掉它）。这里登记一份，退出时统一杀掉。
 */
const runningTtsChildren = new Set<ChildProcess>()

/** 退出路径专用：杀掉所有还在跑的 sherpa-tts 子进程（同步、不等它退出） */
export function killTtsChildrenForExit(): void {
  for (const child of runningTtsChildren) {
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
  }
  runningTtsChildren.clear()
}

/** 从模型文件路径解析描述符：目录名优先（models_root/<dir>/model.onnx），文件名兜底。 */
function resolveSpec(modelPath: string): ModelSpec | undefined {
  // 注意取的是**父目录名**（模型目录 = models_root/<spec.id>），
  // 不是文件名本身——Rust 版用的是 `model_path.parent()`。
  const dir = dirname(modelPath)
  const dirName = basename(dir)
  if (dirName) {
    const spec = findSpec(dirName)
    if (spec) return spec
  }
  const name = basename(modelPath)
  return name ? findSpec(name) : undefined
}

/** 克隆能力的"是否必须配参考文本"（来自描述符，不做模型名分支） */
function cloneRequiresText(voiceMode: VoiceModeSpec): boolean | null {
  if (voiceMode.type === 'clone') return voiceMode.requiresText
  if (voiceMode.type === 'presetAndClone') return voiceMode.clone.requiresText
  return null
}

/** sherpa-onnx E2E TTS 引擎 */
export class SherpaTtsEngine implements TtsEngine {
  private inner: SherpaInner

  constructor() {
    this.inner = {
      spec: null,
      modelRoot: getModelRoot(),
      sid: 0,
      provider: 'cuda',
      numThreads: 4,
      language: 'zh',
      referenceAudio: null,
      referenceText: null
    }
  }

  /**
   * TTS 工具 exe 的规范路径（<sherpa_runtime_dir>/bin/…）。
   * 每次调用解析，不在构造时缓存 —— 保证"先启动应用、后下载框架"也能立刻可用。
   */
  private static ttsExe(): string {
    return sherpaExe('sherpa-onnx-offline-tts.exe')
  }

  /**
   * 检查推理框架与模型文件是否齐全（含 modelsRootFile 参数，如 ZipVoice vocoder）。
   */
  private checkReady(inner: SherpaInner, spec: ModelSpec): void {
    const exe = SherpaTtsEngine.ttsExe()
    if (!existsSync(exe)) {
      throw new Error(`sherpa-onnx TTS 推理框架不存在: ${exe}`)
    }
    const dir = join(inner.modelRoot, spec.id)
    if (!existsSync(dir)) {
      throw new Error(`模型 ${spec.name} 目录不存在: ${dir}`)
    }
    if (spec.backend.type !== 'sherpaTts') {
      throw new Error(`${spec.name} 不是 sherpa TTS 模型`)
    }
    for (const f of spec.backend.requiredFiles) {
      const p = join(dir, f)
      if (!existsSync(p)) {
        throw new Error(`模型 ${spec.name} 缺少文件: ${p}`)
      }
    }
    // modelsRootFile 参数（如 vocos_24khz.onnx）也纳入加载期校验
    for (const arg of spec.backend.cli) {
      if (arg.type === 'modelsRootFile') {
        const p = join(inner.modelRoot, arg.value)
        if (!existsSync(p)) {
          throw new Error(`模型 ${spec.name} 缺少 models 根文件: ${p}`)
        }
      }
    }
  }

  /** 合成并返回 WAV 字节 + 采样率（临时文件方式，避免 stdout 二进制被污染） */
  private synthesizeToFile(inner: SherpaInner, text: string): Promise<{ wav: Buffer; sampleRate: number }> {
    const spec = inner.spec
    if (!spec) return Promise.reject(new Error('TTS 模型未加载'))
    if (spec.backend.type !== 'sherpaTts') {
      return Promise.reject(new Error('非 sherpa TTS 模型'))
    }

    const outPath = join(tmpdir(), `voxflow_tts_${Date.now()}.wav`)
    const env: ArgEnv = {
      modelDir: join(inner.modelRoot, spec.id),
      modelsRoot: inner.modelRoot,
      provider: inner.provider,
      numThreads: inner.numThreads,
      sid: inner.sid,
      language: inner.language,
      output: outPath,
      referenceAudio: inner.referenceAudio,
      referenceText: inner.referenceText
    }

    // 预检：sherpa-onnx 自己的校验只给一句 "Errors in config!"，
    // 这里先按描述符把该在的文件查一遍，缺哪个直接点名。
    const missing = missingFiles(spec.backend.requiredFiles, spec.backend.cli, env)
    if (missing.length > 0) {
      return Promise.reject(
        new Error(
          `模型 ${spec.name} 缺少文件：${missing.join('、')}；请到「模型与设备」重新下载该模型`
        )
      )
    }

    const args = buildArgv(spec.backend.cli, env)
    args.push(`--output-filename=${outPath}`)

    return new Promise((resolve, reject) => {
      const child = spawn(SherpaTtsEngine.ttsExe(), [...args, text], { windowsHide: true })
      runningTtsChildren.add(child)
      const outChunks: Buffer[] = []
      const errChunks: Buffer[] = []
      child.stdout?.on('data', (c: Buffer) => outChunks.push(c))
      child.stderr?.on('data', (c: Buffer) => errChunks.push(c))
      child.on('error', (e) => {
        runningTtsChildren.delete(child)
        rmSync(outPath, { force: true })
        reject(new Error(`sherpa-tts 启动失败: ${e.message}`))
      })
      child.on('close', (code) => {
        runningTtsChildren.delete(child)
        if (code !== 0) {
          rmSync(outPath, { force: true })
          const stderr = Buffer.concat(errChunks).toString('utf-8')
          const last = stderr.split('\n').filter(Boolean).pop() ?? ''
          reject(new Error(`sherpa-tts 失败 (exit=${code ?? -1}): ${last}`))
          return
        }
        let wav: Buffer
        try {
          wav = readFileSync(outPath)
        } catch (e) {
          reject(new Error(`读取合成结果失败: ${e instanceof Error ? e.message : String(e)}`))
          return
        }
        rmSync(outPath, { force: true })
        // 解析采样率（WAV header offset 24）
        const sampleRate = wav.length >= 28 ? wav.readUInt32LE(24) : 24000
        resolve({ wav, sampleRate })
      })
    })
  }

  // ── TtsEngine 实现 ────────────────────────────────────────────────────────

  name(): string {
    return this.inner.spec?.id ?? ''
  }

  async load(modelPath: string, device: string): Promise<void> {
    const spec = resolveSpec(modelPath)
    if (!spec) throw new Error(`无法识别 E2E TTS 模型: ${modelPath}`)

    // 候选状态先写入再校验，校验失败必须回滚：否则 isLoaded()（= spec 非空）会**谎报已加载**
    const prevSpec = this.inner.spec
    const prevProvider = this.inner.provider
    this.inner.spec = spec
    // device → provider（修复旧实现 device 失效：CPU 选项真实生效）
    this.inner.provider = device.trim().toLowerCase() === 'cpu' ? 'cpu' : 'cuda'

    try {
      this.checkReady(this.inner, spec)
    } catch (e) {
      this.inner.spec = prevSpec
      this.inner.provider = prevProvider
      throw e
    }

    // 语言对齐：当前语言不在描述符支持列表 → 切到 "en"（有则用）否则首个支持语言
    if (!spec.languages.includes(this.inner.language)) {
      const fallback = spec.languages.includes('en') ? 'en' : spec.languages[0]
      if (fallback) this.inner.language = fallback
    }
  }

  async unload(): Promise<void> {
    this.inner.spec = null
    this.inner.referenceAudio = null
    this.inner.referenceText = null
  }

  isLoaded(): boolean {
    return this.inner.spec !== null
  }

  async setLanguage(language: string): Promise<void> {
    const spec = this.inner.spec
    if (spec && !spec.languages.includes(language)) {
      throw new Error(
        `模型 ${spec.name} 不支持语言 '${language}'（支持: ${spec.languages.join(', ')}）`
      )
    }
    this.inner.language = language
  }

  /**
   * 设置语音克隆参数（ZipVoice 等克隆模型）。
   *
   * 能力来自描述符（不做模型名分支）：只有 clone / presetAndClone 接受克隆参数。
   */
  async setCloneVoice(audio: string, text: string): Promise<void> {
    const spec = this.inner.spec
    if (!spec) throw new Error('TTS 模型未加载，无法设置克隆音色')

    const requiresText = cloneRequiresText(spec.voiceMode)
    if (requiresText === null) {
      throw new Error(`当前 TTS 模型（${spec.name}）不支持语音克隆`)
    }

    const trimmed = text.trim()
    if (requiresText && !trimmed) {
      throw new Error(`模型 ${spec.name} 需要参考文本（参考音频里说的内容）`)
    }
    if (!existsSync(audio)) {
      throw new Error(`参考音频不存在: ${audio}`)
    }

    this.inner.referenceAudio = audio
    // 空文本存 null：argv 解释器按有/无决定是否拼 `--reference-text`
    this.inner.referenceText = trimmed ? trimmed : null
  }

  /** 清除语音克隆参数（回到预设音色） */
  clearCloneVoice(): void {
    this.inner.referenceAudio = null
    this.inner.referenceText = null
  }

  async synthesize(text: string, voice: string): Promise<SynthAudio> {
    if (!this.isLoaded()) throw new Error('TTS 模型未加载')
    if (!text) return { samples: new Int16Array(0), sampleRate: 0 }

    // voice 参数作为 sid（如 "45"）；非法值保持当前 sid（与旧实现一致）
    const sid = Number.parseInt(voice, 10)
    if (Number.isFinite(sid)) this.inner.sid = sid

    const { wav, sampleRate } = await this.synthesizeToFile(this.inner, text)

    // WAV → i16 PCM：定位 data chunk
    let off = 12
    let dataStart = 0
    let dataLen = 0
    while (off + 8 <= wav.length) {
      const id = wav.toString('ascii', off, off + 4)
      const sz = wav.readUInt32LE(off + 4)
      if (id === 'data') {
        dataStart = off + 8
        dataLen = sz
        break
      }
      off += 8 + sz
    }
    if (dataLen === 0 || dataStart + dataLen > wav.length) {
      throw new Error('合成 WAV 无音频数据')
    }

    const count = Math.floor((dataStart + dataLen - dataStart) / 2)
    const samples = new Int16Array(count)
    for (let i = 0; i < count; i++) {
      samples[i] = wav.readInt16LE(dataStart + i * 2)
    }

    // 返回真实采样率（不再强制 24k / 重采样；WAV 头与 PCM 一致即正确播放）
    return { samples, sampleRate }
  }

  vramEstimateMb(): number | null {
    return null
  }
}
