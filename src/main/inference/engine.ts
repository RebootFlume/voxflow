/**
 * 推理引擎统一抽象 —— 对齐 Rust 版 `src-tauri/src/inference/engine.rs`。
 *
 * P3：陈旧的 `InferenceEngine` / `EngineKind` / `InferInput` / `InferOutput` 已删除
 * （未走 registry 路径，仅 llama_server 一个陈旧 impl）。ASR 走 `AsrEngine` + registry，
 * TTS 走 `tts::traits::TtsEngine` + TtsRegistry。设备枚举在 `inference::device`。
 */

/**
 * 阶段码是「框架无关」的通用集合：loading / initializing / ready
 * （各框架实现可映射自己的内部日志到这些通用码，前端只认这一套）。
 */
export type AsrStage = 'unload' | 'loading' | 'initializing' | 'ready'

/** 阶段回调 */
export type AsrStageCallback = (stage: string) => void

/**
 * ASR 引擎统一抽象：所有 ASR 框架（llama.cpp FFI / sherpa-onnx）
 * 实现此接口，注册到 registry 后即可被统一路由（加载/卸载/转写/显存估算）。
 *
 * 设计目标（横向扩展）：新增一个 ASR 框架 = 新建一个文件实现此接口 +
 * 在 `registry::register` 注册一行。调用方只依赖此接口 + registry，不感知具体框架。
 */
export interface AsrEngine {
  /** 引擎框架标识（gguf / onnx） */
  framework(): string

  /** 加载模型（按名称从注册表动态解析路径） */
  loadModel(name: string): Promise<void>

  /**
   * 带设备参数的加载（cpu / cuda）。默认转发到 `loadModel`（无设备感知），
   * 支持设备切换的引擎覆写此方法（如 llama 的 -ngl、sherpa 的 --provider）。
   */
  loadModelWithDevice(name: string, device: string): Promise<void>

  /** 带阶段回调的加载：stage ∈ {"unload", "loading", "initializing", "ready"} */
  loadModelWithStage(name: string, onStage: AsrStageCallback): Promise<void>

  /** 带阶段回调 + 设备的加载。默认转发到 `loadModelWithStage`（无设备感知）。 */
  loadModelWithStageAndDevice(
    name: string,
    device: string,
    onStage: AsrStageCallback
  ): Promise<void>

  /** 卸载模型（释放显存/内存） */
  unload(): Promise<void>

  /** 模型是否已加载（且可转写） */
  isLoaded(): boolean

  /** 当前已加载模型名（空 = 未加载） */
  currentModel(): string

  /** 转写音频 */
  transcribe(samples: Float32Array, sampleRate: number): Promise<string>

  /**
   * 带「上文」的转写：`ctx` = 前文文本（空 = 无上文，等同 `transcribe`）。
   *
   * 跨段记忆的落点：长音频分段后，每段把「已转写文本的尾部」作为上下文随音频一起送模型，
   * 让接缝处的同音字/半句话靠上文认对。实测（0.6B + 130s 实录，60s 处硬切）：
   * 无上文把「沉淀」认成「纯电」；给出**截断到接缝前**的上文（模型无从照抄）仍认对「沉淀」
   * ⇒ 是真实识别受益，不是复制。
   */
  transcribeWithContext(samples: Float32Array, sampleRate: number, ctx: string): Promise<string>

  /** 估算当前模型显存占用（MB），用于显存监控（无权限时回退估算） */
  vramEstimateMb(): number | null

  /**
   * 引擎**自报**的显存占用（MB）——真值来源。
   *
   * 进程内 FFI 引擎可以读设备显存的加载前后差值，直接回答"我占了多少"，
   * 不必去查别的进程（旧的 WMI/PowerShell 路线一次要 3.3s，且 Windows 下受限）。
   * 不支持自报 → 不实现此方法（调用方回退到估算值）。
   */
  vramSelfReportedMb?(): number | null

  /**
   * 引擎当前**子进程** PID（未加载/无子进程 → null）。
   *
   * 显存监控用它按 PID 精确取真值：按进程名求和会被残留或同名实例顶高
   * （实测踩过：我自己的测试残留实例把"我们的占用"顶到 4.3 GB）。
   */
  pid(): number | null

  /**
   * 退出路径专用：**同步**杀掉引擎子进程（不等它退出、不做协议握手）。
   *
   * 可选方法：只有持有长驻子进程的引擎需要实现
   * （llama.cpp FFI worker / sherpa-onnx FFI worker）。
   * 退出时如果只走 `unload()`（异步、要等协议握手），进程可能来不及
   * 走完握手就被杀掉 → 子进程变成孤儿继续占显存/端口。
   */
  killForExit?(): void
}
