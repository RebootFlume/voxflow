#[allow(unused_imports)]
pub mod audio;
use std::process::Command;
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
pub mod data_root;
#[allow(unused_imports)]
pub mod persistence;
#[allow(unused_imports)]
pub mod sidecar;
#[allow(unused_imports)]
pub mod tray;
pub mod tts;

use tauri::Emitter;

use crate::app_state::AppState;
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
        // ASR：查 registry 当前加载引擎是否匹配该模型（统一路由，未来 PyTorch 自动生效）
        Some("asr") => {
            let r = crate::inference::registry::registry();
            r.active_engine()
                .map(|e| e.current_model() == name)
                .unwrap_or(false)
        }
        Some("tts") => state.tts.lock().is_loaded(),
        _ => false, // 未知模型：无法判定，视为未使用
    }
}

fn emit_error(app: &tauri::AppHandle, msg: String) {
    let _ = app.emit("sidecar://event", serde_json::json!({"status": "error", "msg": msg}));
}

/// 安全版本：所有 action 走 Rust 原生（UI 无感，协议与原 Python sidecar 一致）
///
/// async：Tauri 在 async 运行时执行（非主线程），load_model 等耗时 action
/// （sherpa/llama 模型加载数秒）不再阻塞主线程 → 切换模型不卡 UI。
#[tauri::command]
async fn send_to_sidecar_safe(
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
        "check_capabilities" => {
            // 能力检测：ffmpeg 是否可用（前端 TranscribePanel 依赖此标记决定支持格式）
            let ffmpeg = audio::ffmpeg_decoder::ffmpeg_available();
            let _ = app.emit("sidecar://event", serde_json::json!({
                "status": "capabilities",
                "ffmpeg": ffmpeg,
            }));
            return Ok(serde_json::json!({"ok": true, "ffmpeg": ffmpeg}));
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
            // 根据格式加载到对应引擎（经 registry 统一路由 + ASR 互斥）
            match info.format() {
                model_manager::ModelFormat::Gguf => {
                    // GGUF → llama-server（ASR 主引擎）
                    let registry = crate::inference::registry::registry();
                    match registry.load_model_with_device("gguf", &name, &device) {
                        Ok((_, loaded_name)) => {
                            let _ = app.emit("sidecar://event", serde_json::json!({
                                "status": "model_loaded",
                                "model": loaded_name,
                                "device": device,
                            }));
                        }
                        Err(e) => {
                            eprintln!("[load_model] llama-server load failed: {e}");
                            let _ = app.emit("sidecar://event", serde_json::json!({
                                "status": "model_error",
                                "model": name,
                                "msg": format!("GGUF 引擎加载失败: {e}"),
                            }));
                        }
                    }
                }
                model_manager::ModelFormat::Onnx if info.kind() == "asr" => {
                    // ONNX + ASR → sherpa-onnx websocket server（低端设备引擎）
                    let registry = crate::inference::registry::registry();
                    match registry.load_model_with_device("onnx", &name, &device) {
                        Ok((_, loaded_name)) => {
                            let _ = app.emit("sidecar://event", serde_json::json!({
                                "status": "model_loaded",
                                "model": loaded_name,
                                "device": device,
                            }));
                        }
                        Err(e) => {
                            eprintln!("[load_model] sherpa ASR load failed: {e}");
                            let _ = app.emit("sidecar://event", serde_json::json!({
                                "status": "model_error",
                                "model": name,
                                "msg": format!("sherpa ASR 加载失败: {e}"),
                            }));
                        }
                    }
                }
                model_manager::ModelFormat::Onnx => {
                    // ONNX + TTS → 统一 TtsService（经 State<AppState>）
                    eprintln!("[load_model] ONNX TTS: {}", main_file.display());
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

/// 查询显存状态：总显存 + 已用 + 各推理框架占用（按 PID 过滤 nvidia-smi）
/// 异步：powershell/nvidia-smi/目录遍历都是阻塞操作，放 spawn_blocking 避免卡 UI（转写等高负载时尤甚）
#[tauri::command]
async fn get_vram_status() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(|| get_vram_status_sync()).await.unwrap_or_default()
}

/// 同步实现（供 spawn_blocking 调用）
fn get_vram_status_sync() -> serde_json::Value {
    let gpu = sidecar::detect_gpu();
    let total_mb = gpu.get("memoryMB").and_then(|v| v.as_u64()).unwrap_or(0);

    // nvidia-smi 已用显存（总量，无需权限）
    let used_mb = Command::new("nvidia-smi")
        .args(["--query-gpu=memory.used", "--format=csv,noheader,nounits"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .next()
                    .and_then(|s| s.trim().parse::<u64>().ok())
            } else {
                None
            }
        })
        .unwrap_or(0);

    // 各框架进程显存（按 PID 查询；无权限时为 None → 回退到模型文件大小估算）
    // llama：估算 = 当前加载的模型目录大小（切换 0.6B/1.7B 后自动跟随）
    let llama_mb = vram_of_process("llama-server").or_else(|| {
        let eng = crate::inference::llama_server::global_engine();
        let p = eng.current_model_path();
        // 取模型文件所在目录（含 mmproj），估算整个目录大小
        p.parent().map(|d| dir_size_mb(d)).flatten()
    })
    // registry 兜底：若以上未命中，用注册表统一估算（未来 PyTorch 自动生效）
    .or_else(|| {
        let r = crate::inference::registry::registry();
        if r.active_framework() == "gguf" {
            r.active_vram_mb()
        } else {
            None
        }
    });
    let sherpa_mb = vram_of_process("sherpa-onnx-offline-websocket-server")
        .or_else(|| {
            // 当前加载的 sherpa 模型目录大小
            let eng = crate::inference::sherpa_asr::global_engine();
            let model = eng.model();
            if model.is_empty() {
                None
            } else {
                pathbuf_size_mb(crate::model_manager::model_dir(&model))
            }
        })
        // registry 兜底：若以上未命中，用注册表统一估算（未来 PyTorch 自动生效）
        .or_else(|| {
            let r = crate::inference::registry::registry();
            if r.active_framework() == "onnx" {
                r.active_vram_mb()
            } else {
                None
            }
        });

    serde_json::json!({
        "available": gpu.get("available").and_then(|v| v.as_bool()).unwrap_or(false),
        "gpu_name": gpu.get("gpuName").cloned().unwrap_or(serde_json::Value::String(String::new())),
        "total_mb": total_mb,
        "used_mb": used_mb,
        "frameworks": {
            "llama": llama_mb.map(|m| serde_json::json!({ "mb": m }))
                .unwrap_or_else(|| serde_json::json!(null)),
            "sherpa": sherpa_mb.map(|m| serde_json::json!({ "mb": m }))
                .unwrap_or_else(|| serde_json::json!(null)),
        },
    })
}

/// 查询指定进程名的显存占用（MB）——按 PID 匹配 nvidia-smi
/// 无管理员权限时返回 None（前端显示「不可用」）
fn vram_of_process(name: &str) -> Option<u64> {
    use std::process::Command;
    // 找进程 PID
    let ps_cmd = format!("Get-Process '{name}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id");
    let pid = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_cmd])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8_lossy(&o.stdout).trim().parse::<u32>().ok()
            } else {
                None
            }
        })?;
    // nvidia-smi 按 PID 查
    let out = Command::new("nvidia-smi")
        .args(["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).lines().find_map(|line| {
        let mut parts = line.split(',');
        let pid_str = parts.next()?.trim();
        if pid_str.parse::<u32>().ok()? == pid {
            parts.next()?.trim().parse::<u64>().ok()
        } else {
            None
        }
    })
}

/// 计算目录大小（MB）——用于无权限时按模型文件大小估算显存
fn dir_size_mb(dir: &std::path::Path) -> Option<u64> {
    if !dir.is_dir() {
        return None;
    }
    let mut total: u64 = 0;
    fn walk(d: &std::path::Path, total: &mut u64) {
        if let Ok(rd) = std::fs::read_dir(d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, total);
                } else if let Ok(md) = e.metadata() {
                    *total += md.len();
                }
            }
        }
    }
    walk(dir, &mut total);
    if total > 0 {
        Some(total / (1024 * 1024))
    } else {
        None
    }
}

/// 目录大小（MB）——PathBuf 版本
fn pathbuf_size_mb(dir: std::path::PathBuf) -> Option<u64> {
    dir_size_mb(&dir)
}

/// Rust 原生音频解码（不依赖 Python）
/// 输入：文件路径，输出：16kHz mono float32 samples + 时长
/// 多格式：WAV 走 hound，其他走 ffmpeg 子进程
#[tauri::command]
fn decode_audio_file(path: String) -> Result<serde_json::Value, String> {
    let data = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    let (samples, rate) = audio::decode_any(&data, std::path::Path::new(&path))?;
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

/// 卸载 sherpa ASR 引擎（杀 websocket server 进程）
#[tauri::command]
fn rust_unload_sherpa_asr() -> Result<serde_json::Value, String> {
    crate::inference::sherpa_asr::global_engine().unload();
    Ok(serde_json::json!({ "status": "unloaded" }))
}

// ─── llama-server 子进程 + HTTP 命令 ──────────────────────────────────────

/// 启动 llama-server 子进程（启动后才使用 ASR）。model 指定模型名（Qwen3-ASR-0.6B / Qwen3-ASR-1.7B）
///
/// async + 后台线程：模型加载（子进程启动 + 健康检查等待）耗时数秒，
/// 同步执行会阻塞 Tauri 主线程导致 UI 冻结。改为后台线程加载 + 事件回传：
///   - 立即返回 {"ok": true}（前端先显示 loading）
///   - 加载完成 emit `model_ready`，失败 emit `model_error`（前端已监听）
#[tauri::command]
async fn rust_start_llama_server(
    app: tauri::AppHandle,
    model: Option<String>,
    device: Option<String>,
) -> Result<serde_json::Value, String> {
    let model = model.unwrap_or_else(|| "Qwen3-ASR-0.6B".to_string());
    let device = device.unwrap_or_else(|| "cuda".to_string());
    let device2 = device.clone();
    // 通知前端开始加载（UI 立即进入 loading）
    let _ = app.emit(
        "sidecar://event",
        serde_json::json!({ "status": "model_loading", "model": model }),
    );

    // 后台线程加载（阻塞操作不占主线程）
    let app2 = app.clone();
    let model2 = model.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let load_start = std::time::Instant::now();
        // 阶段回调：卸载 → 启动 → 等待就绪，实时 emit 到前端驱动进度条
        let mut on_stage = |stage: &str| {
            let _ = app2.emit(
                "sidecar://event",
                serde_json::json!({
                    "status": "model_progress",
                    "model": model2,
                    "stage": stage,
                }),
            );
        };
        let result = inference::commands::start_llama_server_with_stage(
            Some(&model2),
            &device2,
            &mut on_stage,
        );
        match result {
            Ok(v) => {
                let _ = app2.emit(
                    "sidecar://event",
                    serde_json::json!({
                        "status": "model_ready",
                        "model": model2,
                        "device": device2,
                        "detail": v,
                        "load_ms": load_start.elapsed().as_millis(),
                    }),
                );
            }
            Err(e) => {
                let _ = app2.emit(
                    "sidecar://event",
                    serde_json::json!({ "status": "model_error", "model": model2, "msg": e }),
                );
            }
        }
    });

    // 立即返回（不等待加载完成）
    Ok(serde_json::json!({ "ok": true, "loading": true, "model": model }))
}

/// 停止 llama-server 子进程
#[tauri::command]
fn rust_stop_llama_server() -> Result<serde_json::Value, String> {
    inference::commands::stop_llama_server()
}

/// 查询 llama-server 状态
#[tauri::command]
fn rust_llama_server_status() -> serde_json::Value {
    inference::commands::llama_server_status()
}

/// 通过 llama-server 转写音频文件（支持多格式解码 + 长音频分批 + 进度 + 导出）
#[tauri::command]
async fn rust_transcribe_llama(
    app: tauri::AppHandle,
    file_path: String,
    export_dir: Option<String>,
    export_format: Option<String>,
) -> Result<serde_json::Value, String> {
    let app2 = app.clone();
    let fp2 = file_path.clone();
    // 后台线程转写：长音频分批时每段完成后 emit 进度事件（不占主线程）
    tauri::async_runtime::spawn_blocking(move || {
        let mut on_progress = |done_sec: f64, total_sec: f64| {
            let _ = app2.emit(
                "sidecar://event",
                serde_json::json!({
                    "status": "transcribe_progress",
                    "path": fp2,
                    "progress": ((done_sec / total_sec.max(1.0)) * 100.0).round() as u32,
                    "done_sec": done_sec,
                    "total_sec": total_sec,
                }),
            );
        };
        inference::commands::transcribe_file_with_progress(
            &file_path,
            export_dir.as_deref(),
            export_format.as_deref(),
            &mut on_progress,
        )
    })
    .await
    .map_err(|e| format!("转写线程失败: {e}"))?
}

/// 测试 TTS 模型加载（打印输入输出 tensor 名称）
#[tauri::command]
fn rust_test_tts_model(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let model_path = crate::model_manager::model_dir("Kokoro-v1_0")
        .join("model.onnx");
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
        .setup(|app| {
            // 统一数据根：便携模式（exe旁data\）或安装模式（AppData）
            // 初始化模型根 = 数据根/models（替代前端 bootstrap 传 model_root）
            let data_root = crate::data_root::get_data_root(app.handle());
            let _ = model_manager::set_model_root(&data_root.join("models").to_string_lossy());

            // 启动录音 worker + rdev 全局监听（幂等，热键链路依赖）
            hotkey::start_capslock_listener(app.handle().clone());
            // 迁移旧布局模型目录（下载目录名 → 引擎目录名）
            // 后台线程执行，避免磁盘扫描阻塞窗口显示（白屏 1-2s）
            let app2 = app.handle().clone();
            std::thread::Builder::new()
                .name("legacy-dir-migrate".into())
                .spawn(move || {
                    model_manager::migrate_legacy_dirs(&app2);
                })
                .ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            set_hotkey,
            send_to_sidecar_safe,
            get_gpu_info,
            get_vram_status,
            decode_audio_file,
            rust_list_audio_devices,
            rust_unload_sherpa_asr,
            rust_start_llama_server,
            rust_stop_llama_server,
            rust_llama_server_status,
            rust_transcribe_llama,
            tts::commands::rust_load_tts_model,
            tts::commands::rust_synthesize,
            tts::commands::rust_set_tts_language,
            tts::commands::rust_list_tts_voices,
            tts::commands::rust_list_e2e_tts_models,
            tts::commands::rust_switch_e2e_tts_model,
            tts::commands::rust_unload_tts_model,
            tts::commands::rust_set_tts_clone_voice,
            tts::commands::rust_clear_tts_clone_voice,
            tts::commands::rust_list_tts_speakers,
            rust_test_tts_model,
            hf_download_file,
            hf_download_as_string,
            hf_download_multiple,
            persistence::read_data_file,
            persistence::write_data_file,
            persistence::get_data_dir
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // 应用退出：统一清理子进程（llama-server / sherpa server），避免残留
            if let tauri::RunEvent::Exit = event {
                let _ = crate::inference::llama_server::global_engine().unload();
                crate::inference::sherpa_asr::global_engine().unload();
            }
        });
}
