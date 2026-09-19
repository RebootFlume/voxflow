//! 推理引擎统一抽象 trait
//!
//! P3：陈旧的 `InferenceEngine` / `EngineKind` / `InferInput` / `InferOutput` 已删除
//! （未走 registry 路径，仅 llama_server 一个陈旧 impl）。ASR 走 `AsrEngine` + registry，
//! TTS 走 `tts::traits::TtsEngine` + TtsRegistry。设备枚举在 `inference::device`。

/// ASR 引擎统一抽象：所有 ASR 框架（llama-server / sherpa-onnx / 未来 PyTorch）
/// 实现此 trait，注册到 `registry` 后即可被统一路由（加载/卸载/转写/显存估算）。
///
/// 设计目标（横向扩展）：新增一个 ASR 框架 = 新建一个文件实现此 trait +
/// 在 `registry::register` 注册一行。lib.rs / hotkey.rs / get_vram_status 等
/// 调用方只依赖此 trait + registry，不感知具体框架。
pub trait AsrEngine: Send + Sync {
    /// 引擎框架标识（gguf / onnx / pytorch）
    fn framework(&self) -> &'static str;

    /// 加载模型（按名称从注册表动态解析路径）
    fn load_model(&self, name: &str) -> Result<(), String>;

    /// 带设备参数的加载（cpu / cuda）。默认转发到 `load_model`（无设备感知），
    /// 支持设备切换的引擎覆写此方法（如 llama 的 -ngl、sherpa 的 --provider）。
    fn load_model_with_device(&self, name: &str, device: &str) -> Result<(), String> {
        let _ = device;
        self.load_model(name)
    }

    /// 带阶段回调的加载：stage ∈ {"unload", "loading", "ready"}
    fn load_model_with_stage(
        &self,
        name: &str,
        _on_stage: &mut dyn FnMut(&str),
    ) -> Result<(), String> {
        self.load_model(name)
    }

    /// 带阶段回调 + 设备的加载。默认转发到 `load_model_with_stage`（无设备感知），
    /// 支持设备切换的引擎覆写此方法。
    fn load_model_with_stage_and_device(
        &self,
        name: &str,
        device: &str,
        on_stage: &mut dyn FnMut(&str),
    ) -> Result<(), String> {
        let _ = device;
        self.load_model_with_stage(name, on_stage)
    }

    /// 卸载模型（释放显存/内存）
    fn unload(&self) -> Result<(), String>;

    /// 模型是否已加载（且可转写）
    fn is_loaded(&self) -> bool;

    /// 当前已加载模型名（空 = 未加载）
    fn current_model(&self) -> String;

    /// 转写音频
    fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String, String>;

    /// 带「上文」的转写：`ctx` = 前文文本（空 = 无上文，等同 `transcribe`）。
    ///
    /// 跨段记忆的落点：长音频分段后，每段把「已转写文本的尾部」作为上下文随音频一起送模型，
    /// 让接缝处的同音字/半句话靠上文认对。实测（0.6B + 130s 实录，60s 处硬切）：
    /// 无上文把「沉淀」认成「纯电」；给出**截断到接缝前**的上文（模型无从照抄）仍认对「沉淀」
    /// ⇒ 是真实识别受益，不是复制。
    ///
    /// 默认实现忽略 `ctx`：不具备上下文能力的引擎（如 sherpa）行为与改动前完全一致。
    fn transcribe_with_context(
        &self,
        samples: &[f32],
        sample_rate: u32,
        _ctx: &str,
    ) -> Result<String, String> {
        self.transcribe(samples, sample_rate)
    }

    /// 估算当前模型显存占用（MB），用于显存监控（无权限时回退估算）
    fn vram_estimate_mb(&self) -> Option<u64>;

    /// 引擎当前**子进程** PID（未加载/无子进程 → None）。
    ///
    /// 显存监控用它按 PID 精确取真值：按进程名求和会被残留或同名实例顶高
    /// （实测踩过：我自己的测试残留实例把"我们的占用"顶到 4.3 GB）。
    fn pid(&self) -> Option<u32> {
        None
    }
}
