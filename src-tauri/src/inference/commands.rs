//! 推理引擎 Tauri 命令桥接
//!
//! llama-server 子进程命令（ASR 主力路线）。
//! 旧 AsrEngine（llama-cpp-2 占位）已移除，ASR 走 llama-server / sherpa 子进程。

use super::llama_server::global_engine;
use super::engine::InferenceEngine;
use super::super::audio;

// ============================================================
// llama-server 子进程命令
// ============================================================

/// 启动 llama-server 子进程
///
/// 前端调用：`invoke('rust_start_llama_server')`
/// 返回：`{"ok": true, "loaded": true}` 或错误信息
pub fn start_llama_server() -> Result<serde_json::Value, String> {
    let engine = global_engine();
    engine.load().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "ok": true,
        "loaded": engine.is_loaded(),
        "model": engine.model_name().unwrap_or(""),
    }))
}

/// 停止 llama-server 子进程
pub fn stop_llama_server() -> Result<serde_json::Value, String> {
    let engine = global_engine();
    engine.unload().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"ok": true, "loaded": false}))
}

/// 查询 llama-server 状态
pub fn llama_server_status() -> serde_json::Value {
    let engine = global_engine();
    serde_json::json!({
        "loaded": engine.is_loaded(),
        "model": engine.model_name().unwrap_or(""),
    })
}

/// 通过 llama-server 转写文件
///
/// 路径仅作保留调用接口，底层走 HTTP：
///   1. 解码音频到 16kHz float32
///   2. POST /v1/audio/transcriptions （OpenAI 兼容）
///   3. 解析 {"text": "..."}
pub fn transcribe_file_via_llama_server(file_path: &str) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(file_path);
    if !path.exists() {
        return Err(format!("file not found: {}", file_path));
    }

    // 1. 解码音频
    let data = std::fs::read(path).map_err(|e| format!("read file failed: {e}"))?;
    let (samples, sample_rate) = audio::decode_audio(&data)?;
    if samples.is_empty() {
        return Ok(serde_json::json!({"text": "", "duration": 0.0}));
    }
    let duration = samples.len() as f64 / sample_rate as f64;

    // 2. 启动子进程（如未运行）
    let engine = global_engine();
    engine.load().map_err(|e| e.to_string())?;

    // 3. 转写
    let text = engine.transcribe(&samples, sample_rate).map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "text": text,
        "duration": (duration * 100.0).round() / 100.0,
        "model": engine.model_name().unwrap_or(""),
    }))
}
