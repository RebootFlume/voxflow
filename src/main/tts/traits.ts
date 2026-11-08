/**
 * TTS 引擎抽象 —— 对齐 Rust 版 `src-tauri/src/tts/traits.rs`。
 *
 * 契约（P1 冻结）：
 * - `synthesize` 返回 `SynthAudio`（带**真实采样率**），不再硬编码 24k、不再重采样。
 * - 新增方法一律提供默认实现，不破坏已注册引擎。
 */

/** 合成音频：采样率由引擎按模型实际输出声明 */
export interface SynthAudio {
  /** 16bit 单声道 PCM */
  samples: Int16Array
  sampleRate: number
}

/** TTS 引擎接口（框架契约） */
export interface TtsEngine {
  /** 引擎/当前模型名称（未加载时为空字符串） */
  name(): string

  /** 加载模型（`modelPath` 为主模型文件路径；`device` 为 "cpu"/"cuda"/"directml"/"metal"） */
  load(modelPath: string, device: string): Promise<void>

  /** 卸载模型（释放显存/内存） */
  unload(): Promise<void>

  /** 模型是否已加载 */
  isLoaded(): boolean

  /** 按语言切换（轻量，不重载模型；引擎按自身描述符的语言列表校验） */
  setLanguage(language: string): Promise<void>

  /** 端到端合成：纯文本 → PCM + 真实采样率 */
  synthesize(text: string, voice: string): Promise<SynthAudio>

  /** 设置语音克隆参数（仅克隆模型支持；默认拒绝，避免命令层向下转型） */
  setCloneVoice(audio: string, text: string): Promise<void>

  /** 清除语音克隆参数（默认 no-op） */
  clearCloneVoice(): void

  /** 估算当前模型显存占用（MB），用于显存监控；无权限时回退 null */
  vramEstimateMb(): number | null

  /**
   * 退出路径专用：同步终止引擎进程（不等它退出）。
   *
   * 可选：进程内引擎（FFI worker）实现它；纯内存引擎可不实现。
   * 异步的 `unload()` 在退出路径上等不及，会在托盘退出时卡好几秒。
   */
  killForExit?(): void
}

/**
 * 合成取消令牌（分段边界生效）
 * —— 对齐 Rust 版 `app_state.rs::TtsCancel`。
 *
 * 引擎的一次 `synthesize` 是不可中断的子进程调用，所以取消只能在**段与段之间**生效。
 * `begin`/`end` 由合成方调用，`request` 只在确有合成在跑时置位，
 * 避免「上一次的取消」误伤下一次合成。
 */
export class TtsCancel {
  private running = false
  private cancelled = false

  /** 合成开始：清掉历史取消标记并置为运行中 */
  begin(): void {
    this.cancelled = false
    this.running = true
  }

  /** 合成结束（正常 / 失败 / 被取消） */
  end(): void {
    this.running = false
    this.cancelled = false
  }

  /** 是否已被请求取消（段循环每段查一次） */
  isCancelled(): boolean {
    return this.cancelled
  }

  /** 请求取消；返回是否确有正在进行的合成 */
  request(): boolean {
    if (!this.running) return false
    this.cancelled = true
    return true
  }
}
