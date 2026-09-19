//! TTS 引擎子系统（端到端 / E2E）
//!
//! - `spec`：模型描述符表（ModelSpec，框架与模型解耦的契约；ASR/TTS 一张表）
//! - `traits`：共享类型（TtsResult / SynthAudio）与 `TtsEngine` 抽象（&self 冻结）
//! - `registry`：TtsRegistry（路由 + 互斥，取代 service.rs 分发器）
//! - `engine`：sherpa 子进程引擎（argv.rs 解释器 + sherpa.rs）
//! - `commands`：Tauri 命令桥接（前端 IPC）
//!
//! P3 删除：`config`（ModelManifest）、`tokenizer`、`engine::onnx`（进程内 ONNX 线，
//! 无使用者）+ `ort` 依赖；`engine::e2e_registry` 已并入 `spec` 删除。
//! P4：能力字段（languages / language_mode / voice_mode / supports_clone）由
//! `models_state` 事件承载（model_manager::list_models_payload），不再走独立命令。

pub mod commands;
pub mod engine;
pub mod reference_audio;
pub mod registry;
pub mod voices;
pub mod spec;
pub mod traits;

pub use registry::TtsRegistry;
