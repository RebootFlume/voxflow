//! TTS 引擎子系统
//!
//! - `traits`：共享类型（PipelineContext / TtsResult）与 `TtsEngine` 抽象
//! - `config`：ModelManifest（模型差异 → 配置，新模型不写 Rust 代码）
//! - `middleware`：文本处理中间件（direct_tokenizer / espeak_phonemizer / vocab_mapper）
//! - `engine`：统一 ONNX 推理器（按 manifest 组装张量）
//! - `service`：统一调度 Service
//! - `commands`：Tauri 命令桥接（前端 IPC）

pub mod commands;
pub mod config;
pub mod engine;
pub mod middleware;
pub mod service;
pub mod traits;

pub use service::TtsService;
pub use traits::TtsEngine as TtsTrait;
