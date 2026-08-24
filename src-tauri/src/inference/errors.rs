//! 推理引擎错误类型（历史别名 → 统一 `crate::errors::AppError`）

pub use crate::errors::AppError as InferenceError;

pub type InferenceResult<T> = Result<T, InferenceError>;
