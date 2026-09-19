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

    /// 估算当前模型显存占用（MB），用于显存监控（无权限时回退估算）
    fn vram_estimate_mb(&self) -> Option<u64>;
}
