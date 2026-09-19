//! ASR 引擎注册表：统一路由 + 互斥
//!
//! 所有 ASR 框架（llama-server / sherpa-onnx / 未来 PyTorch）实现
//! `engine::AsrEngine` trait 后注册到这里。上层（lib.rs 的 load_model、
//! hotkey.rs 的录音转写、get_vram_status 的显存监控）只依赖本模块，
//! 不感知具体框架 —— 新增框架只需「实现 trait + 注册一行」。
//!
//! 互斥规则（用户确认）：同一时间只有一个 ASR 引擎加载。
//! 加载新 ASR 模型前，自动卸载另一个 ASR 框架的模型。
//! 互斥 / active 查询与 TtsRegistry 共用 `slot::EngineSlot`（单一实现）。

use std::sync::Arc;

use super::engine::AsrEngine;
use super::llama_server;
use super::sherpa_asr;
use super::slot::EngineSlot;

/// 已注册的 ASR 引擎（顺序 = 加载优先级：gguf 主引擎在前）
///
/// 新增框架（如 PyTorch）在此追加一行：
/// ```ignore
/// ("pytorch", Arc::new(pytorch::PyTorchAsrAdapter::new()) as Arc<dyn AsrEngine>),
/// ```
pub struct AsrRegistry {
    slot: EngineSlot<dyn AsrEngine>,
}

impl AsrRegistry {
    /// 按模型名解析引擎注册键（模型存在性 + kind 校验；键来自描述符数据，无需 match）
    pub fn framework_for_model(&self, name: &str) -> Result<&'static str, String> {
        let spec = crate::tts::spec::ModelSpec::find(name)
            .ok_or_else(|| format!("未知模型: {name}"))?;
        if spec.kind.as_str() != "asr" {
            return Err(format!("{name} 不是 ASR 模型"));
        }
        Ok(spec.framework)
    }

    /// 按模型名加载 ASR（唯一权威路由：查注册表 format → 互斥 → 引擎加载）。
    /// 所有入口（UI 切换 / 热键兜底 / 文件转写 / API）都走这里，保证互斥不被绕过。
    pub fn load_asr_by_name(
        &self,
        name: &str,
        device: &str,
        on_stage: &mut dyn FnMut(&str),
    ) -> Result<(&'static str, String), String> {
        // 记录本次请求（任意框架）：兜底加载跟随用户当前选择
        crate::inference::llama_server::record_last_requested(name, device);
        let fw = self.framework_for_model(name)?;
        self.load_model_with_stage(fw, name, device, on_stage)
    }

    /// 加载「最近一次被请求」的 ASR 模型（注册表路由，保证互斥）——热键/文件/API 兜底用。
    /// 无任何请求记录时退回注册表默认模型。
    pub fn load_requested_asr(
        &self,
        on_stage: &mut dyn FnMut(&str),
    ) -> Result<(&'static str, String), String> {
        let (name, device) = crate::inference::llama_server::last_requested_model()
            .unwrap_or_else(|| ("Qwen3-ASR-0.6B".to_string(), "cuda".to_string()));
        self.load_asr_by_name(&name, &device, on_stage)
    }

    fn new() -> Self {
        Self {
            slot: EngineSlot::new(vec![
                // gguf → llama-server（ASR 主引擎）
                ("gguf", Arc::new(llama_server::LlamaAsrAdapter::new()) as Arc<dyn AsrEngine>),
                // onnx → sherpa-onnx websocket server（低端设备引擎）
                ("onnx", Arc::new(sherpa_asr::SherpaAsrAdapter::new()) as Arc<dyn AsrEngine>),
            ]),
        }
    }

    /// 按框架取引擎
    pub fn engine(&self, framework: &str) -> Option<Arc<dyn AsrEngine>> {
        self.slot.engine(framework)
    }

    /// 当前已加载的引擎（有且只有一个）
    pub fn active_engine(&self) -> Option<Arc<dyn AsrEngine>> {
        self.slot.active().map(|(_, e)| e)
    }

    /// 当前已加载的框架名（如 "gguf" / "onnx"），无则空
    pub fn active_framework(&self) -> &'static str {
        self.slot.active().map(|(f, _)| f).unwrap_or("")
    }

    /// 统一加载：卸载其他框架的引擎，再加载指定框架的模型。
    /// 返回 (framework, model_name)
    pub fn load_model(&self, framework: &str, name: &str) -> Result<(&'static str, String), String> {
        self.load_model_with_device(framework, name, "cuda")
    }

    /// 带设备加载（cpu / cuda），透传到引擎的 load_model_with_device
    pub fn load_model_with_device(
        &self,
        framework: &str,
        name: &str,
        device: &str,
    ) -> Result<(&'static str, String), String> {
        // 1. 找目标引擎
        let engine = self
            .engine(framework)
            .ok_or_else(|| format!("未知框架: {framework}"))?;

        // 幂等判定交给引擎层（模型名相同≠设备/参数相同），注册表只负责互斥与路由。

        // 2. 卸载其他框架的引擎（ASR 互斥：同一时间只一个）
        let _ = self.slot.unload_others(framework);

        // 3. 加载目标引擎（带设备）
        engine.load_model_with_device(name, device)?;
        Ok((engine.framework(), engine.current_model()))
    }

    /// 带阶段回调的加载（驱动前端进度条）
    pub fn load_model_with_stage(
        &self,
        framework: &str,
        name: &str,
        device: &str,
        on_stage: &mut dyn FnMut(&str),
    ) -> Result<(&'static str, String), String> {
        let engine = self
            .engine(framework)
            .ok_or_else(|| format!("未知框架: {framework}"))?;

        // 注意：不做注册表层的"已加载同模型"短路 —— 模型名相同但设备/参数可能不同，
        // 幂等与身份验证交给引擎层（llama：running_matches 校验 model+采样+启动参数；
        // sherpa：模型+设备都相等才算幂等）。注册表只负责互斥与路由。

        // 互斥：先卸载其他框架（stage 带出被卸载的模型名，卸载前上报，时序与重构前一致）
        self.slot.unload_others_with(framework, &mut |_f, victim| {
            let stage = if victim.is_empty() {
                "unload".to_string()
            } else {
                format!("unload:{victim}")
            };
            on_stage(&stage);
        });

        engine.load_model_with_stage_and_device(name, device, on_stage)?;
        Ok((engine.framework(), engine.current_model()))
    }

    /// 卸载指定框架的引擎（未加载则 no-op）
    pub fn unload(&self, framework: &str) -> Result<(), String> {
        if let Some(e) = self.engine(framework) {
            let _ = e.unload();
        }
        Ok(())
    }

    /// 卸载当前已加载的引擎
    pub fn unload_active(&self) -> Result<(), String> {
        if let Some(e) = self.active_engine() {
            let _ = e.unload();
        }
        Ok(())
    }

    /// 当前已加载引擎的显存估算（MB）
    pub fn active_vram_mb(&self) -> Option<u64> {
        self.active_engine().and_then(|e| e.vram_estimate_mb())
    }
}

// ─── 全局单例 ──────────────────────────────────────────────────────────────

use std::sync::LazyLock;

static REGISTRY: LazyLock<Arc<AsrRegistry>> = LazyLock::new(|| Arc::new(AsrRegistry::new()));

/// 获取全局 ASR 引擎注册表（首次解引用时初始化）。
/// 注意：首次初始化必须在非异步上下文完成（见方案 10.3.1：阻塞 HTTP client 构造禁止在 tokio 上下文析构）。
pub fn registry() -> Arc<AsrRegistry> {
    REGISTRY.clone()
}
