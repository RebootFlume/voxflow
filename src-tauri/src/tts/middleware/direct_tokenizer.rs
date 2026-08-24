//! A 轨：Text → Token IDs（Direct Pipeline）
//!
//! 适用于 Qwen-TTS / Chatterbox / TADA 等端到端模型：文本直接经
//! HuggingFace tokenizer 编码，无需 G2P。
//!
//! ⚠️ 尚未接入 `tokenizers` crate（架构文档 Phase 3 规划）。
//! 当前诚实报错，避免前端误以为 Direct 管道可用。

use crate::errors::AppError;

/// 文本 → token ids（Direct 管道；暂未接入，如实报错）
pub fn direct_tokenize(_text: &str, _vocab: &std::collections::HashMap<String, u32>) -> Result<Vec<i64>, AppError> {
    Err(AppError::G2pFailed(
        "Direct pipeline not implemented yet — HuggingFace tokenizer integration pending".to_string(),
    ))
}
