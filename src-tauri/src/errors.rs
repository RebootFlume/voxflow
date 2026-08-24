//! 统一应用错误类型
//!
//! Rust 端不做 i18n，错误消息一律英文，由前端按需展示。
//! `inference::errors::InferenceError` 为历史别名，指向本类型。

use serde::ser::{Serialize, SerializeStruct, Serializer};

/// 应用级错误
#[derive(Debug, Clone)]
pub enum AppError {
    /// 模型文件不存在或格式不支持
    ModelNotFound(String),
    /// 模型加载失败（文件损坏、显存不足等）
    LoadFailed(String),
    /// 推理过程失败
    InferenceFailed(String),
    /// G2P（文本 → 音素）失败
    G2pFailed(String),
    /// 引擎未初始化
    NotInitialized,
    /// 输入格式错误
    InvalidInput(String),
}

impl AppError {
    /// 机器可读的错误分类（供前端做针对性提示）
    fn kind_str(&self) -> &'static str {
        match self {
            Self::ModelNotFound(_) => "model_not_found",
            Self::LoadFailed(_) => "load_failed",
            Self::InferenceFailed(_) => "inference_failed",
            Self::G2pFailed(_) => "g2p_failed",
            Self::NotInitialized => "not_initialized",
            Self::InvalidInput(_) => "invalid_input",
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ModelNotFound(p) => write!(f, "model not found: {p}"),
            Self::LoadFailed(msg) => write!(f, "model load failed: {msg}"),
            Self::InferenceFailed(msg) => write!(f, "inference failed: {msg}"),
            Self::G2pFailed(msg) => write!(f, "G2P failed: {msg}"),
            Self::NotInitialized => write!(f, "engine not initialized"),
            Self::InvalidInput(msg) => write!(f, "invalid input: {msg}"),
        }
    }
}

impl std::error::Error for AppError {}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("kind", self.kind_str())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}
