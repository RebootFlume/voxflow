//! 推理引擎 Tauri 命令桥接
//!
//! 前端通过 invoke 调用 Rust 推理，不再经过 Python sidecar。
//! TTS 命令已迁至 `crate::tts::commands`（统一 TtsService）；本模块仅保留 ASR。

use parking_lot::Mutex;

use super::asr::AsrEngine;
use super::engine::{Device, InferInput, InferenceEngine};
use super::super::audio;

/// ASR 推理命令：从文件路径识别语音
pub fn transcribe_file_rust(
    engine: &Mutex<AsrEngine>,
    file_path: &str,
) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(file_path);
    if !path.exists() {
        return Err(format!("file not found: {}", file_path));
    }

    // 1. 解码音频文件
    let data = std::fs::read(path).map_err(|e| format!("read file failed: {e}"))?;
    let (samples, sample_rate) = audio::decode_audio(&data)?;

    if samples.is_empty() {
        return Ok(serde_json::json!({"text": "", "duration": 0.0}));
    }

    let duration = samples.len() as f64 / sample_rate as f64;

    // 2. 调用 ASR 引擎推理
    let mut guard = engine.lock();
    if !guard.is_loaded() {
        return Err("ASR model not loaded".into());
    }

    let input = InferInput::Audio { samples, sample_rate };
    let output = guard.infer(&input).map_err(|e| e.to_string())?;

    match output {
        super::engine::InferOutput::Transcript { text, .. } => {
            Ok(serde_json::json!({
                "text": text,
                "duration": (duration * 100.0).round() / 100.0,
            }))
        }
        _ => Err("ASR output format error".into()),
    }
}

/// 模型加载命令
pub fn load_asr_model(
    engine: &Mutex<AsrEngine>,
    model_path: &str,
    device: &str,
) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(model_path);
    let dev = Device::from_str(device);

    let mut guard = engine.lock();
    guard.load(path, dev).map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "status": "loaded",
        "model": guard.model_name().unwrap_or(""),
        "device": guard.device().to_str(),
    }))
}

/// ASR 模型卸载
pub fn unload_asr_model(engine: &Mutex<AsrEngine>) -> Result<(), String> {
    engine.lock().unload().map_err(|e| e.to_string())
}

/// 查询 ASR 模型状态
pub fn get_asr_status(engine: &Mutex<AsrEngine>) -> serde_json::Value {
    let guard = engine.lock();
    serde_json::json!({
        "loaded": guard.is_loaded(),
        "model": guard.model_name().unwrap_or(""),
        "device": guard.device().to_str(),
        "state": format!("{:?}", guard.state()),
    })
}
