#![allow(dead_code)]

//! 推理引擎模块：llama-server 子进程（GGUF）+ sherpa-onnx websocket（ONNX）
//!
//! - llama_server：Qwen3-ASR GGUF 推理（子进程 + HTTP）
//! - sherpa_asr：SenseVoice / Paraformer 推理（websocket server 子进程）

pub mod engine;
pub mod llama_server;
pub mod sherpa_asr;
pub mod registry;
pub mod errors;
pub mod commands;
pub mod transcribe_chunks;
pub mod runtime_paths;
pub mod runtime_download;

#[cfg(test)]
mod tests;

