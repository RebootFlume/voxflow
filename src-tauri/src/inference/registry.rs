//! ASR 引擎注册表：统一路由 + 互斥
//!
//! 所有 ASR 框架（llama-server / sherpa-onnx / 未来 PyTorch）实现
//! `engine::AsrEngine` trait 后注册到这里。上层（lib.rs 的 load_model、
//! hotkey.rs 的录音转写、get_vram_status 的显存监控）只依赖本模块，
//! 不感知具体框架 —— 新增框架只需「实现 trait + 注册一行」。
//!
//! 互斥规则（用户确认）：同一时间只有一个 ASR 引擎加载。
//! 加载新 ASR 模型前，自动卸载另一个 ASR 框架的模型。

use std::sync::Arc;

use super::engine::AsrEngine;
use super::llama_server;
use super::sherpa_asr;

/// 已注册的 ASR 引擎（顺序 = 加载优先级：gguf 主引擎在前）
///
/// 新增框架（如 PyTorch）在此追加一行：
/// ```ignore
/// (Framework::PyTorch, Arc::new(pytorch::PyTorchAsrEngine::new())),
/// ```
pub struct AsrRegistry {
    engines: Vec<(&'static str, Arc<dyn AsrEngine>)>,
}

/// 当前注册的 ASR 框架（与 model_manager::ModelFormat 对应）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AsrFramework {
    Gguf,
    Onnx,
    /// 未来：PyTorch ASR（torch 子进程服务）
    PyTorch,
}

impl AsrFramework {
    pub fn as_str(&self) -> &'static str {
        match self {
            AsrFramework::Gguf => "gguf",
            AsrFramework::Onnx => "onnx",
            AsrFramework::PyTorch => "pytorch",
        }
    }
}

impl AsrRegistry {
    fn new() -> Self {
        Self {
            engines: vec![
                // gguf → llama-server（ASR 主引擎）
                ("gguf", Arc::new(llama_server::LlamaAsrAdapter::new()) as Arc<dyn AsrEngine>),
                // onnx → sherpa-onnx websocket server（低端设备引擎）
                ("onnx", Arc::new(sherpa_asr::SherpaAsrAdapter::new()) as Arc<dyn AsrEngine>),
            ],
        }
    }

    /// 按框架取引擎
    pub fn engine(&self, framework: &str) -> Option<Arc<dyn AsrEngine>> {
        self.engines
            .iter()
            .find(|(f, _)| *f == framework)
            .map(|(_, e)| e.clone())
    }

    /// 当前已加载的引擎（有且只有一个）
    pub fn active_engine(&self) -> Option<Arc<dyn AsrEngine>> {
        self.engines
            .iter()
            .map(|(_, e)| e.clone())
            .find(|e| e.is_loaded())
    }

    /// 当前已加载的框架名（如 "gguf" / "onnx"），无则空
    pub fn active_framework(&self) -> &'static str {
        self.engines
            .iter()
            .find(|(_, e)| e.is_loaded())
            .map(|(f, _)| *f)
            .unwrap_or("")
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

        // 2. 互斥：如果目标引擎已加载同模型 → 直接返回
        if engine.is_loaded() && engine.current_model() == name {
            return Ok((engine.framework(), engine.current_model()));
        }

        // 3. 卸载其他框架的引擎（ASR 互斥：同一时间只一个）
        for (other_f, other_e) in &self.engines {
            if *other_f != framework && other_e.is_loaded() {
                let _ = other_e.unload();
            }
        }

        // 4. 加载目标引擎（带设备）
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

        if engine.is_loaded() && engine.current_model() == name {
            return Ok((engine.framework(), engine.current_model()));
        }

        // 互斥：先卸载其他框架
        for (other_f, other_e) in &self.engines {
            if *other_f != framework && other_e.is_loaded() {
                on_stage("unload");
                let _ = other_e.unload();
            }
        }

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

use std::sync::OnceLock;

static REGISTRY: OnceLock<Arc<AsrRegistry>> = OnceLock::new();

/// 获取全局 ASR 引擎注册表（懒加载）
pub fn registry() -> Arc<AsrRegistry> {
    REGISTRY
        .get_or_init(|| Arc::new(AsrRegistry::new()))
        .clone()
}
