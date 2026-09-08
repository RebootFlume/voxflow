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
    /// 注册表 format → registry framework 标识。
    /// 新增框架（如 PyTorch）只需在此加一个 match 分支 + 注册表引擎行。
    pub fn framework_for_format(f: &crate::model_manager::ModelFormat) -> Option<&'static str> {
        match f {
            crate::model_manager::ModelFormat::Gguf => Some("gguf"),
            crate::model_manager::ModelFormat::Onnx => Some("onnx"),
        }
    }

    /// 按模型名从注册表解析 framework（模型存在性 + kind 校验）
    pub fn framework_for_model(&self, name: &str) -> Result<&'static str, String> {
        let info = crate::model_manager::find_model_info(name)
            .ok_or_else(|| format!("未知模型: {name}"))?;
        if info.kind() != "asr" {
            return Err(format!("{name} 不是 ASR 模型"));
        }
        Self::framework_for_format(info.format())
            .ok_or_else(|| format!("{name} 的格式缺少对应引擎"))
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

        // 幂等判定交给引擎层（模型名相同≠设备/参数相同），注册表只负责互斥与路由。

        // 2. 卸载其他框架的引擎（ASR 互斥：同一时间只一个）
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

        // 注意：不做注册表层的"已加载同模型"短路 —— 模型名相同但设备/参数可能不同，
        // 幂等与身份验证交给引擎层（llama：running_matches 校验 model+采样+启动参数；
        // sherpa：模型+设备都相等才算幂等）。注册表只负责互斥与路由。

        // 互斥：先卸载其他框架（stage 带出被卸载的模型名，便于日志追踪切换流程）
        for (other_f, other_e) in &self.engines {
            if *other_f != framework && other_e.is_loaded() {
                let victim = other_e.current_model();
                let stage = if victim.is_empty() {
                    "unload".to_string()
                } else {
                    format!("unload:{victim}")
                };
                on_stage(&stage);
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
