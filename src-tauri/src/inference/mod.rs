#![allow(dead_code)]

//! 推理引擎模块：ONNX Runtime (ort) + GGUF (llama.cpp) 双引擎架构
//!
//! 统一抽象层：所有引擎实现 `InferenceEngine` trait，
//! 前端通过 Tauri invoke 调用，不经过 Python sidecar。

pub mod engine;
pub mod asr;
pub mod errors;
pub mod commands;

#[cfg(test)]
mod tests;

