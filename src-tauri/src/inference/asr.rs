//! ASR 语音识别引擎
//!
//! ⚠️ 尚未接入 llama-cpp-2 真实推理（迁移 TODO）。
//! 当前实现是诚实的占位：`load` / `infer` 一律返回「未实现」错误，
//! 避免前端误以为模型已加载、识别结果有效（此前是假 `Ready` + 假识别文本）。
//!
//! 接入规划：把 llama-cpp-2 的 `LlamaModel` / `LlamaContext` / `MtmdContext`
//! 作为本结构体的字段（`Box` 持有，`Drop` 自动释放），不需要裸指针与 `unsafe`。

use std::path::Path;

use super::engine::{Device, EngineKind, InferInput, InferOutput, InferenceEngine};
use super::errors::{InferenceError, InferenceResult};

/// ASR 引擎状态
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AsrState {
    Uninitialized,
    Loading,
    Error(String),
}

pub struct AsrEngine {
    state: AsrState,
}

impl AsrEngine {
    pub fn new() -> Self {
        Self { state: AsrState::Uninitialized }
    }
    pub fn state(&self) -> &AsrState {
        &self.state
    }
}

impl InferenceEngine for AsrEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::LlamaCpp
    }

    fn load(&mut self, _model_path: &Path, _device: Device) -> InferenceResult<()> {
        self.state = AsrState::Loading;
        let err = "ASR engine not implemented yet: llama-cpp-2 (GGUF) integration pending";
        self.state = AsrState::Error(err.to_string());
        Err(InferenceError::LoadFailed(err.to_string()))
    }

    fn unload(&mut self) -> InferenceResult<()> {
        self.state = AsrState::Uninitialized;
        Ok(())
    }

    fn is_loaded(&self) -> bool {
        false
    }

    fn model_name(&self) -> Option<&str> {
        None
    }

    fn device(&self) -> Device {
        Device::Cpu
    }

    fn infer(&mut self, _input: &InferInput) -> InferenceResult<InferOutput> {
        Err(InferenceError::NotInitialized)
    }
}
