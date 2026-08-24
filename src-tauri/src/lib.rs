#[allow(unused_imports)]
pub mod audio;
mod app_state;
#[allow(unused_imports)]
pub mod clipboard;
#[allow(unused_imports)]
pub mod download;
mod errors;
#[allow(unused_imports)]
pub mod hotkey;
pub mod inference;
pub mod model_manager;
#[allow(unused_imports)]
pub mod persistence;
#[allow(unused_imports)]
pub mod sidecar;
#[allow(unused_imports)]
pub mod tray;
pub mod tts;

use tauri::Emitter;

use crate::app_state::AppState;
use crate::inference::engine::InferenceEngine;
use crate::tts::traits::TtsEngine;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn set_hotkey(app: tauri::AppHandle, hotkey: String) -> Result<(), String> {
    hotkey::register_combo(&app, &hotkey)
}

/// 模型是否使用中：按注册表 kind（与前端 modelState.resolveModelKind 一致）判定对应引擎
fn is_model_in_use(state: &AppState, name: &str) -> bool {
    match model_manager::find_model_info(name).map(|i| i.kind()) {
        Some("asr") => state.asr.lock().is_loaded(),
        Some("tts") => state.tts.lock().is_loaded(),
        _ => false, // 未知模型：无法判定，视为未使用
    }
}

fn emit_error(app: &tauri::AppHandle, msg: String) {
    let _ = app.emit("sidecar://event", serde_json::json!({"status": "error", "msg": msg}));
}

/// 安全版本：所有 action 走 Rust 原生（UI 无感，协议与原 Python sidecar 一致）
#[tauri::command]
fn send_to_sidecar_safe(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let action = payload.get("action").and_then(|a| a.as_str()).unwrap_or("");
    match action {
        "bootstrap" => {
            if let Some(root) = payload.get("model_root").and_then(|v| v.as_str()) {
                if !root.trim().is_empty() {
                    let _ = model_manager::set_model_root(root);
                }
            }
            if let Some(ep) = payload.get("mirror_endpoint").and_then(|v| v.as_str()) {
                model_manager::set_mirror(ep);
            }
            if let Some(proxy) = payload.get("proxy").and_then(|v| v.as_str()) {
                model_manager::set_proxy(proxy);
            }
            model_manager::emit_models_state(&app);
            return Ok(serde_json::json!({"ok": true}));
        }
        "set_model_root" => {
            let path = payload.get("path").and_then(|v| v.as_str()).unwrap_or("");
            match model_manager::set_model_root(path) {
                Ok(p) => {
                    let _ = app.emit("sidecar://event", serde_json::json!({"status": "model_root_set", "path": p.display().to_string()}));
                    model_manager::emit_models_state(&app);
                    return Ok(serde_json::json!({"ok": true}));
                }
                Err(e) => {
                    emit_error(&app, e.clone());
                    return Ok(serde_json::json!({"status": "error", "msg": e}));
                }
            }
        }
        "set_mirror" => {
            let ep = payload.get("endpoint").and_then(|v| v.as_str()).unwrap_or("");
            model_manager::set_mirror(ep);
            let _ = app.emit("sidecar://event", serde_json::json!({"status": "mirror_set", "mirror": ep}));
            model_manager::emit_models_state(&app);
            return Ok(serde_json::json!({"ok": true}));
        }
        "set_proxy" => {
            let proxy = payload.get("proxy").and_then(|v| v.as_str()).unwrap_or("");
            let normalized = model_manager::set_proxy(proxy);
            let _ = app.emit("sidecar://event", serde_json::json!({"status": "proxy_set", "proxy": normalized}));
            return Ok(serde_json::json!({"ok": true, "proxy": normalized}));
        }
        "list_models" => {
            let kind = payload.get("kind").and_then(|v| v.as_str());
            if kind.is_some() {
                let p = model_manager::list_models_payload(kind);
                let _ = app.emit("sidecar://event", p);
            } else {
                model_manager::emit_models_state(&app);
            }
            return Ok(serde_json::json!({"ok": true}));
        }
        "download_model" => {
            let name = payload.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if name.is_empty() {
                let msg = "missing model".to_string();
                emit_error(&app, msg.clone());
                return Ok(serde_json::json!({"status": "error", "msg": msg}));
            }
            match model_manager::start_download(app.clone(), &name) {
                Ok(()) => {
                    let _ = app.emit("sidecar://event", serde_json::json!({"status": "model_download_started", "model": name}));
                    // 触发前端轮询态
                    model_manager::emit_models_state(&app);
                    return Ok(serde_json::json!({"ok": true}));
                }
                Err(e) => {
                    emit_error(&app, e.clone());
                    return Ok(serde_json::json!({"status": "error", "msg": e}));
                }
            }
        }
        "cancel_download" => {
            let name = payload.get("model").and_then(|v| v.as_str()).unwrap_or("");
            let ok = model_manager::request_cancel(name);
            if !ok {
                let msg = format!("no active download: {name}");
                emit_error(&app, msg.clone());
                return Ok(serde_json::json!({"status": "error", "msg": msg}));
            }
            return Ok(serde_json::json!({"ok": true}));
        }
        "delete_model" => {
            let name = payload.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if is_model_in_use(&state, &name) {
                let msg = format!("model in use: {name}");
                emit_error(&app, msg.clone());
                return Ok(serde_json::json!({"status": "error", "msg": msg}));
            }
            match model_manager::delete_model(&name) {
                Ok(freed) => {
                    let _ = app.emit("sidecar://event", serde_json::json!({"status": "model_deleted", "model": name, "freed_bytes": freed}));
                    model_manager::emit_models_state(&app);
                    return Ok(serde_json::json!({"ok": true}));
                }
                Err(e) => {
                    emit_error(&app, e.clone());
                    return Ok(serde_json::json!({"status": "error", "msg": e}));
                }
            }
        }
        "load_model" => {
            let name = payload.get("model").and_then(|v| v.as_str()).unwrap_or("");
            let device = payload.get("device").and_then(|v| v.as_str()).unwrap_or("cpu");
            if name.is_empty() {
                let msg = "missing model".to_string();
                emit_error(&app, msg.clone());
                return Ok(serde_json::json!({"status": "error", "msg": msg}));
            }
            // 通知前端开始加载
            let _ = app.emit("sidecar://event", serde_json::json!({"status": "model_loading", "model": name}));
            // 查找模型信息
            let info = match model_manager::find_model_info(name) {
                Some(i) => i.clone(),
                None => {
                    let msg = format!("unknown model: {name}");
                    emit_error(&app, msg.clone());
                    return Ok(serde_json::json!({"status": "error", "msg": msg}));
                }
            };
            let dir = model_manager::model_dir(name);
            // 根据格式查找主模型文件
            let main_file = match model_manager::find_main_model_file(&dir, info.format()) {
                Some(f) => f,
                None => {
                    let msg = format!("model file not found for {name} (format: {:?})", info.format());
                    let _ = app.emit("sidecar://event", serde_json::json!({"status": "model_not_downloaded", "model": name, "msg": msg}));
                    return Ok(serde_json::json!({"status": "error", "msg": msg}));
                }
            };
            // 根据格式加载到对应引擎
            match info.format() {
                model_manager::ModelFormat::Gguf => {
                    // GGUF → llama-cpp-2 引擎（尚未接入）：诚实报错，不假装加载成功
                    let msg = "ASR GGUF engine not implemented yet".to_string();
                    eprintln!("[load_model] GGUF not implemented: {}", main_file.display());
                    let _ = app.emit("sidecar://event", serde_json::json!({
                        "status": "model_error",
                        "model": name,
                        "msg": msg,
                    }));
                }
                model_manager::ModelFormat::Onnx => {
                    // ONNX → ort 引擎（统一 TtsService，经 State<AppState>）
                    eprintln!("[load_model] ONNX: {}", main_file.display());
                    let mut guard = state.tts.lock();
                    match guard.load(&main_file, device) {
                        Ok(()) => {
                            let _ = app.emit("sidecar://event", serde_json::json!({
                                "status": "model_ready",
                                "model": name,
                                "device": device,
                            }));
                        }
                        Err(e) => {
                            let msg = format!("TTS load failed: {e}");
                            emit_error(&app, msg.clone());
                            let _ = app.emit("sidecar://event", serde_json::json!({
                                "status": "model_error",
                                "model": name,
                                "msg": msg,
                            }));
                        }
                    }
                }
            }
            return Ok(serde_json::json!({"ok": true}));
        }
        // 其它 action（录音、转写等由前端直接调 Rust 命令，此处留空兜底）
        _ => Ok(serde_json::json!({"ok": true})),
    }
}




/// 前端同步查询 GPU 信息（nvidia-smi，<100ms，不依赖 Python）
#[tauri::command]
fn get_gpu_info() -> serde_json::Value {
    sidecar::detect_gpu()
}

/// Rust 原生音频解码（不依赖 Python）
/// 输入：文件路径，输出：16kHz mono float32 samples + 时长
#[tauri::command]
fn decode_audio_file(path: String) -> Result<serde_json::Value, String> {
    let data = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    let (samples, rate) = audio::decode_audio(&data)?;
    let duration = samples.len() as f64 / rate as f64;
    Ok(serde_json::json!({
        "samples": samples,
        "sample_rate": rate,
        "duration": (duration * 100.0).round() / 100.0,
    }))
}

// ============================================================
// Rust 原生推理引擎命令
// ============================================================

/// 加载 ASR 模型
/// 支持传入模型名称（如 "Qwen3-ASR-0.6B"）或完整文件路径
/// 优先在 modelRoot 下查找，失败后自动回退到 workspace/models（开发期镜像）
#[tauri::command]
fn rust_load_asr_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model_path: String,
    device: String,
) -> Result<serde_json::Value, String> {
    let name = model_path.clone();
    // 判断是模型名还是文件路径
    let actual_path = if std::path::Path::new(&model_path).exists() {
        std::path::PathBuf::from(&model_path)
    } else {
        let primary = model_manager::model_dir(&model_path);
        let found = model_manager::find_main_model_file(&primary, &model_manager::ModelFormat::Gguf)
            .or_else(|| {
                // 开发期回退：workspace/models 下的镜像
                let fallback = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../models/qwen3-asr-0.6b-gguf");
                model_manager::find_main_model_file(&fallback, &model_manager::ModelFormat::Gguf)
            });
        match found {
            Some(f) => f,
            None => return Err(format!("model file not found for: {model_path}")),
        }
    };
    let result = inference::commands::load_asr_model(&state.asr, &actual_path.to_string_lossy(), &device);
    match &result {
        Ok(_) => { let _ = app.emit("sidecar://event", serde_json::json!({"status": "model_ready", "model": name, "device": device})); }
        Err(e) => { let _ = app.emit("sidecar://event", serde_json::json!({"status": "model_error", "model": name, "msg": e.to_string()})); }
    }
    result
}

/// ASR 语音识别
#[tauri::command]
fn rust_transcribe(
    state: tauri::State<'_, AppState>,
    file_path: String,
) -> Result<serde_json::Value, String> {
    inference::commands::transcribe_file_rust(&state.asr, &file_path)
}

/// Rust 原生音频设备枚举（替代 Python list_audio_devices）
#[tauri::command]
fn rust_list_audio_devices() -> serde_json::Value {
    let devices = audio::capture::list_input_devices();
    let current_name = audio::capture::get_default_input_name();
    let devices_json: Vec<serde_json::Value> = devices
        .iter()
        .map(|d| {
            serde_json::json!({
                "id": d.id,
                "name": d.name,
                "channels": d.channels,
                "is_default": d.is_default,
            })
        })
        .collect();
    serde_json::json!({
        "status": "audio_devices",
        "devices": devices_json,
        "current": current_name,
        "currentName": current_name,
    })
}
#[tauri::command]
fn rust_asr_status(state: tauri::State<'_, AppState>) -> serde_json::Value {
    inference::commands::get_asr_status(&state.asr)
}

/// 测试 TTS 模型加载（打印输入输出 tensor 名称）
#[tauri::command]
fn rust_test_tts_model(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let model_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../models/Kokoro-82M/onnx/model.onnx");
    if !model_path.exists() {
        return Err(format!("TTS model not found: {}", model_path.display()));
    }
    let mut g = state.tts.lock();
    g.load(&model_path, "cpu").map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"status": "loaded", "model": g.name(), "device": "cpu"}))
}

// ============================================================
// Hugging Face 模型下载命令
// ============================================================

/// 从 Hugging Face 下载模型文件
#[tauri::command]
fn hf_download_file(
    model_id: String,
    filename: String,
    token: Option<String>,
    cache_dir: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut config = download::DownloadConfig::new(&model_id, &filename)
        .with_env_token();

    if let Some(t) = token {
        config = config.with_token(t);
    }

    if let Some(dir) = cache_dir {
        config = config.with_cache_dir(std::path::PathBuf::from(dir));
    }

    let downloader = download::SyncDownloader::new(&config)
        .map_err(|e| e.to_string())?;

    let path = downloader
        .download_file(&config)
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "model_id": model_id,
        "filename": filename,
    }))
}

/// 从 Hugging Face 下载模型文件并返回内容（JSON 字符串）
#[tauri::command]
fn hf_download_as_string(
    model_id: String,
    filename: String,
    token: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut config = download::DownloadConfig::new(&model_id, &filename)
        .with_env_token();

    if let Some(t) = token {
        config = config.with_token(t);
    }

    let downloader = download::SyncDownloader::new(&config)
        .map_err(|e| e.to_string())?;

    let content = downloader
        .download_as_string(&config)
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "content": content,
        "model_id": model_id,
        "filename": filename,
    }))
}

/// 批量下载多个文件
#[tauri::command]
fn hf_download_multiple(
    model_id: String,
    filenames: Vec<String>,
    token: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut config = download::DownloadConfig::new(&model_id, "")
        .with_env_token();

    if let Some(t) = token {
        config = config.with_token(t);
    }

    let downloader = download::SyncDownloader::new(&config)
        .map_err(|e| e.to_string())?;

    let paths = downloader
        .download_files(&model_id, &filenames)
        .map_err(|e| e.to_string())?;

    let paths_str: Vec<String> = paths
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    Ok(serde_json::json!({
        "paths": paths_str,
        "model_id": model_id,
        "count": paths.len(),
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            set_hotkey,
            send_to_sidecar_safe,
            get_gpu_info,
            decode_audio_file,
            rust_list_audio_devices,
            rust_load_asr_model,
            rust_transcribe,
            rust_asr_status,
            tts::commands::rust_load_tts_model,
            tts::commands::rust_synthesize,
            tts::commands::rust_set_tts_language,
            tts::commands::rust_list_tts_voices,
            rust_test_tts_model,
            hf_download_file,
            hf_download_as_string,
            hf_download_multiple,
            persistence::read_data_file,
            persistence::write_data_file,
            persistence::get_data_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
