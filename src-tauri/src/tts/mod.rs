//! TTS 引擎子系统（端到端 / E2E）
//!
//! - `traits`：共享类型（TtsResult）与 `TtsEngine` 抽象
//! - `config`：ModelManifest（模型差异 → 配置，新模型不写 Rust 代码）
//! - `tokenizer`：E2E 文本分词器（纯文本 → token ids，无音素 / G2P）
//! - `engine`：统一 ONNX 推理器（按 manifest 组装张量）
//! - `service`：统一调度 Service
//! - `commands`：Tauri 命令桥接（前端 IPC）

pub mod commands;
pub mod config;
pub mod engine;
pub mod service;
pub mod tokenizer;
pub mod traits;

pub use service::TtsService;
pub use traits::TtsEngine as TtsTrait;
