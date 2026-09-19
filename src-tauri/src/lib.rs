#[allow(unused_imports)]
pub mod audio;
pub mod process_hidden;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
mod app_state;
#[allow(unused_imports)]
pub mod clipboard;
#[allow(unused_imports)]
pub mod download;
mod errors;
#[allow(unused_imports)]
pub mod hotkey;
pub mod inference;
mod log_bridge;
pub mod model_manager;
pub mod data_root;
#[allow(unused_imports)]
pub mod persistence;
#[allow(unused_imports)]
pub mod sidecar;
#[allow(unused_imports)]
pub mod tray;
pub mod tts;
#[allow(unused_imports)]
pub mod api_server;

use parking_lot::Mutex;
use tauri::Emitter;
use tauri::Manager;

use crate::app_state::AppState;
use crate::tts::registry::TtsRegistry;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn set_hotkey(app: tauri::AppHandle, hotkey: String) -> Result<(), String> {
    hotkey::register_combo(&app, &hotkey)
}

/// 模型是否使用中：按注册表 kind（与前端 modelState.resolveModelKind 一致）判定对应引擎
///
/// 取 `tts` 句柄而非 `&AppState`：命令侧需把本函数移入阻塞池（State 不能跨线程边界）。
fn is_model_in_use(tts: &Arc<Mutex<TtsRegistry>>, name: &str) -> bool {
    match crate::tts::spec::ModelSpec::find(name).map(|i| i.kind.as_str()) {
        // ASR：查 registry 当前加载引擎是否匹配该模型（统一路由，未来 PyTorch 自动生效）
        Some("asr") => {
            let r = crate::inference::registry::registry();
            r.active_engine()
                .map(|e| e.current_model() == name)
                .unwrap_or(false)
        }
        Some("tts") => tts.lock().is_loaded(),
        _ => false, // 未知模型：无法判定，视为未使用
    }
}

fn emit_error(app: &tauri::AppHandle, msg: String) {
    let _ = app.emit("sidecar://event", serde_json::json!({"status": "error", "msg": msg}));
}

/// 安全版本：所有 action 走 Rust 原生（UI 无感，协议与原 Python sidecar 一致）
///
/// async + 阻塞池：Tauri 不在主线程执行，且 action 分发整体下沉 `spawn_blocking`
/// （load_model 等耗时 action 含起子进程 / 等端口 / 触达引擎，且会构造阻塞 client）。
#[tauri::command]
async fn send_to_sidecar_safe(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // State 不能跨线程边界移动：先取出 tts 句柄，整个分发下沉阻塞池。
    // R2 根因：各 action 触达 registry / 引擎（会构造 reqwest::blocking::Client），
    // 在 tokio 异步上下文里构造/析构自带 Runtime 的 client 会 panic。
    let tts = state.tts.clone();
    tauri::async_runtime::spawn_blocking(move || dispatch_sidecar_action(&app, &tts, &payload))
        .await
        .map_err(|e| format!("sidecar task failed: {e}"))?
}

/// `send_to_sidecar_safe` 的同步实现（阻塞池内执行；action 分发，协议与原 Python sidecar 一致）
fn dispatch_sidecar_action(
    app: &tauri::AppHandle,
    tts: &Arc<Mutex<TtsRegistry>>,
    payload: &serde_json::Value,
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
            if let Some(token) = payload.get("hf_token").and_then(|v| v.as_str()) {
                model_manager::set_token(token);
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
        "set_token" => {
            // HF 下载 token：只接收存储，不回显（避免明文泄漏到日志/事件）
            let token = payload.get("token").and_then(|v| v.as_str()).unwrap_or("");
            let saved = model_manager::set_token(token);
            let _ = app.emit("sidecar://event", serde_json::json!({"status": "token_set", "has_token": !saved.is_empty()}));
            return Ok(serde_json::json!({"ok": true}));
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
            if is_model_in_use(tts, &name) {
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
            // 查找模型描述符（单一真源：tts::spec::SPECS）
            let spec = match crate::tts::spec::ModelSpec::find(name) {
                Some(i) => i,
                None => {
                    let msg = format!("unknown model: {name}");
                    emit_error(&app, msg.clone());
                    return Ok(serde_json::json!({"status": "error", "msg": msg}));
                }
            };
            let dir = model_manager::model_dir(name);
            // 根据格式查找主模型文件
            let main_file = match model_manager::find_main_model_file(&dir, &spec.format) {
                Some(f) => f,
                None => {
                    let msg = format!("model file not found for {name} (format: {:?})", spec.format);
                    let _ = app.emit("sidecar://event", serde_json::json!({"status": "model_not_downloaded", "model": name, "msg": msg}));
                    return Ok(serde_json::json!({"status": "error", "msg": msg}));
                }
            };
            // 按描述符 kind 路由到所属域；框架由 registry 从描述符推导（命令层不再写框架字面量）
            match spec.kind {
                crate::tts::spec::ModelKind::Asr => {
                    let registry = crate::inference::registry::registry();
                    // 错误文案沿用描述符后端（与重构前 GGUF / sherpa ASR 两类文案一致）
                    let prefix = match &spec.backend {
                        crate::tts::spec::BackendSpec::Llama(_) => "GGUF 引擎加载失败",
                        _ => "sherpa ASR 加载失败",
                    };
                    match registry.load_asr_by_name(name, device, &mut |_| {}) {
                        Ok((_fw, loaded_name)) => {
                            let _ = app.emit("sidecar://event", serde_json::json!({
                                "status": "model_loaded",
                                "model": loaded_name,
                                "device": device,
                            }));
                        }
                        Err(e) => {
                            eprintln!("[load_model] ASR 加载失败({}): {e}", spec.id);
                            let _ = app.emit("sidecar://event", serde_json::json!({
                                "status": "model_error",
                                "model": name,
                                "msg": format!("{prefix}: {e}"),
                            }));
                        }
                    }
                }
                crate::tts::spec::ModelKind::Tts => {
                    // TTS → TtsRegistry（按描述符路由，经阻塞池传入的 tts 句柄）
                    eprintln!("[load_model] TTS: {}", main_file.display());
                    let guard = tts.lock();
                    match guard.load(name, device) {
                        Ok((_fw, loaded)) => {
                            let _ = app.emit("sidecar://event", serde_json::json!({
                                "status": "model_ready",
                                "kind": "tts",
                                "model": loaded,
                                "device": device,
                            }));
                        }
                        Err(e) => {
                            let msg = format!("TTS load failed: {e}");
                            emit_error(&app, msg.clone());
                            let _ = app.emit("sidecar://event", serde_json::json!({
                                "status": "model_error",
                                "kind": "tts",
                                "model": name,
                                "msg": msg,
                            }));
                        }
                    }
                }
            }
            return Ok(serde_json::json!({"ok": true}));
        }
        "start_api" => {
            let host = payload.get("host").and_then(|v| v.as_str()).unwrap_or("127.0.0.1").to_string();
            let port = payload.get("port").and_then(|v| v.as_u64()).unwrap_or(9870) as u16;
            let api_key = payload.get("api_key").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let cfg = crate::api_server::ApiConfig { host, port, api_key, tts: tts.clone() };
            match crate::api_server::start(cfg) {
                Ok(()) => {
                    let _ = app.emit("sidecar://event", serde_json::json!({"status": "api_started", "port": port}));
                    Ok(serde_json::json!({"ok": true}))
                }
                Err(e) => {
                    emit_error(&app, e.clone());
                    Ok(serde_json::json!({"status": "error", "msg": e}))
                }
            }
        }
        "stop_api" => {
            crate::api_server::stop();
            let _ = app.emit("sidecar://event", serde_json::json!({"status": "api_stopped"}));
            Ok(serde_json::json!({"ok": true}))
        }
        // 其它 action（录音、转写等由前端直接调 Rust 命令，此处留空兜底）
        _ => Ok(serde_json::json!({"ok": true})),
    }
}




/// 前端同步查询 GPU 信息（nvidia-smi，<100ms，不依赖 Python）
///
/// async + 阻塞池：nvidia-smi 是起子进程，不得在主线程内联（与 get_vram_status 同模板）。
/// 无 State → 返回类型保持不变。
#[tauri::command]
async fn get_gpu_info() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(sidecar::detect_gpu)
        .await
        .unwrap_or_default()
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
    let mut smi_cmd = Command::new("nvidia-smi");
    crate::process_hidden::hide_console_window(&mut smi_cmd);
    let used_mb = smi_cmd
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

    // 各框架进程显存（按 PID 查询）。
    // 关键：进程不存在（引擎已卸载/释放）时绝不能回退到"模型目录大小"估算——
    // 那会在引擎死后假报占用。只有引擎 is_loaded()（子进程活着）却查不到
    // nvidia-smi 明细（无权限）时，才用目录大小近似。
    let llama_mb = vram_of_process("llama-server")
        .or_else(|| {
            let eng = crate::inference::llama_server::global_engine();
            if !eng.is_loaded() {
                return None; // 引擎已卸载：显存已释放，不再估算
            }
            // 引擎活着但查不到明细（无权限）→ 用模型目录大小近似
            let p = eng.current_model_path();
            p.parent().map(|d| dir_size_mb(d)).flatten()
        })
        .or_else(|| registry_vram_mb_if_active("gguf"));
    let sherpa_mb = vram_of_process("sherpa-onnx-offline-websocket-server")
        .or_else(|| {
            let eng = crate::inference::sherpa_asr::global_engine();
            if !eng.is_loaded() {
                return None; // 引擎已卸载：显存已释放，不再估算
            }
            let model = eng.model();
            if model.is_empty() {
                None
            } else {
                pathbuf_size_mb(crate::model_manager::model_dir(&model))
            }
        })
        .or_else(|| registry_vram_mb_if_active("onnx"));

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

/// 指定框架在 registry 中 active 时的估算显存（registry 内部用 is_loaded 过滤，
/// 引擎已卸载自动排除 → 安全）
fn registry_vram_mb_if_active(framework: &'static str) -> Option<u64> {
    let r = crate::inference::registry::registry();
    if r.active_framework() == framework {
        r.active_vram_mb()
    } else {
        None
    }
}

/// 查询指定进程名的显存占用（MB）——按 PID 匹配 nvidia-smi
/// 无管理员权限时返回 None（前端显示「不可用」）
fn vram_of_process(name: &str) -> Option<u64> {
    use std::process::Command;
    // 找进程 PID
    let ps_cmd = format!("Get-Process '{name}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id");
    let mut ps = Command::new("powershell");
    crate::process_hidden::hide_console_window(&mut ps);
    let pid = ps
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
    let mut smi = Command::new("nvidia-smi");
    crate::process_hidden::hide_console_window(&mut smi);
    let out = smi
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
///
/// async + 阻塞池：读盘 + ffmpeg 子进程（含等超时）不可占主线程。
/// 无 State → 返回类型保持不变（仍为 Result，错误语义不变）。
#[tauri::command]
async fn decode_audio_file(path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
        let (samples, rate) = audio::decode_any(&data, std::path::Path::new(&path))?;
        let duration = samples.len() as f64 / rate as f64;
        Ok(serde_json::json!({
            "samples": samples,
            "sample_rate": rate,
            "duration": (duration * 100.0).round() / 100.0,
        }))
    })
    .await
    .map_err(|e| format!("解码任务失败: {e}"))?
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
///
/// async + 阻塞池：卸载含杀进程 + 等端口关闭，不可占主线程。
#[tauri::command]
async fn rust_unload_sherpa_asr() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::inference::sherpa_asr::global_engine().unload();
        Ok(serde_json::json!({ "status": "unloaded" }))
    })
    .await
    .map_err(|e| format!("卸载任务失败: {e}"))?
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
///
/// async + 阻塞池：停止含杀进程 + 等端口关闭（最长数秒），不可占主线程。
#[tauri::command]
async fn rust_stop_llama_server() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(inference::commands::stop_llama_server)
        .await
        .map_err(|e| format!("停止引擎任务失败: {e}"))?
}

/// 查询 llama-server 状态
///
/// async + 阻塞池：is_loaded 内含 HTTP /health 健康检查 + 子进程探测。
/// 无 State → 返回类型保持不变。
#[tauri::command]
async fn rust_llama_server_status() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(inference::commands::llama_server_status)
        .await
        .unwrap_or_default()
}

/// 统一 ASR 加载请求号：前端用它丢弃旧请求的迟到事件（只认最新 reqId）
static NEXT_ASR_REQ: AtomicU64 = AtomicU64::new(0);

/// 统一 ASR 模型加载入口（替代 rust_start_llama_server / sidecar load_model 的分叉）。
///
/// 设计要点（完整切换流程）：
///   1. 路由依据 = 注册表里模型自身的 format/kind（registry.framework_for_model），不做名字推断；
///   2. 互斥（llama/sherpa/未来 pytorch 同一时间只一个）由 registry.load_asr_by_name 统一强制；
///   3. 每次请求必然产生且只产生一个终态事件（model_ready / model_error），
///      全部带 reqId；即使加载线程卡死/panic，兜底也会补发 model_error —— 不会"卡 loading"；
///   4. 立即返回 {reqId}，前端用它做新请求覆盖旧请求（迟到事件按 reqId 丢弃）。
#[tauri::command]
async fn rust_load_asr(
    app: tauri::AppHandle,
    model: String,
    device: Option<String>,
) -> Result<serde_json::Value, String> {
    let device = device.unwrap_or_else(|| "cuda".to_string());
    let req = NEXT_ASR_REQ.fetch_add(1, Ordering::SeqCst) + 1;

        // 注册表权威框架（事件带出，前端据此切换模型页标签，无需猜）
        // 经阻塞池取：注册表首次初始化会构造阻塞 HTTP client，在异步上下文构造/析构会 panic
        let fw_model = model.clone();
        let fw_opt: Option<String> = tauri::async_runtime::spawn_blocking(move || {
            crate::inference::registry::registry()
                .framework_for_model(&fw_model)
                .ok()
                .map(|f| f.to_string())
        })
        .await
        .unwrap_or(None);

    let _ = app.emit("sidecar://event", serde_json::json!({
        "status": "model_loading", "reqId": req, "kind": "asr",
        "model": model, "device": device, "framework": fw_opt,
    }));

    // 后台执行 + 终态兜底（fire-and-forget：立即返回，事件驱动状态）
    let app2 = app.clone();
    let model2 = model.clone();
    let model_resp = model.clone();
    let device2 = device.clone();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        // 独立线程跑加载；主 async 任务用 recv_timeout 等终态，线程卡死也能兜底补发 error
        let (tx, rx) = std::sync::mpsc::channel::<Result<(String, String), String>>();
        std::thread::Builder::new()
            .name("asr-load".into())
            .spawn(move || {
                let registry = crate::inference::registry::registry();
                let mut on_stage = |s: &str| {
                    let _ = app2.emit("sidecar://event", serde_json::json!({
                        "status": "model_progress", "reqId": req, "kind": "asr",
                        "model": model2, "device": device2, "stage": s,
                    }));
                };
                // 注册表权威路由 + 互斥 + 引擎加载（含未知模型/非 ASR/缺框架的校验）
                let r = registry
                    .load_asr_by_name(&model2, &device2, &mut on_stage)
                    .map(|(fw, name)| (fw.to_string(), name));
                let _ = tx.send(r);
            })
            .ok();

        // 等终态（240s 上限）：线程卡死/panic（channel 断开）都视为失败 → 终态必达
        let result = rx.recv_timeout(std::time::Duration::from_secs(240));
        let result: Result<(String, String), String> = match result {
            Ok(Ok(pair)) => Ok(pair),
            Ok(Err(e)) => Err(e),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // 兜底：卸载残留引擎，保证下次加载干净（阻塞池执行：卸载会杀进程 + 等端口）
                let _ = tauri::async_runtime::spawn_blocking(|| {
                    crate::inference::registry::registry().unload_active()
                })
                .await;
                Err("模型加载超时（240s），已中止并清理残留".into())
            }
            Err(_disconnected) => Err("加载线程异常退出".into()),
        };

        match result {
            Ok((fw, name)) => {
                let _ = app.emit("sidecar://event", serde_json::json!({
                    "status": "model_ready", "reqId": req, "kind": "asr",
                    "model": name, "device": device, "framework": fw,
                    "load_ms": started.elapsed().as_millis(),
                }));
            }
            Err(e) => {
                let _ = app.emit("sidecar://event", serde_json::json!({
                    "status": "model_error", "reqId": req, "kind": "asr",
                    "model": model, "device": device, "msg": e,
                }));
            }
        }
    });

    Ok(serde_json::json!({ "ok": true, "reqId": req, "model": model_resp, "loading": true }))
}

/// 状态快照序号：单调递增。并发对账时事件/响应可能乱序到达，前端凭 seq 丢弃陈旧快照。
static NEXT_STATUS_SEQ: AtomicU64 = AtomicU64::new(0);

/// 构建状态快照（在阻塞池执行：`snapshot()` 会做 HTTP 健康检查，不可占主线程）。
/// 每个引擎的状态经 `snapshot()` 单次读取取齐，不会出现 loaded=true 但模型名为空的撕裂状态。
fn build_status_snapshot() -> serde_json::Value {
    let llama = crate::inference::llama_server::global_engine().snapshot();
    let (loaded, model, device) = if llama.loaded {
        (true, llama.model, llama.device)
    } else {
        let sherpa = crate::inference::sherpa_asr::global_engine().snapshot();
        if sherpa.loaded {
            (true, sherpa.model, sherpa.device)
        } else {
            (false, String::new(), String::new())
        }
    };
    status_snapshot_value(loaded, model, device)
}

/// 组装 status_snapshot 事件体（含单调 seq）
fn status_snapshot_value(loaded: bool, model: String, device: String) -> serde_json::Value {
    serde_json::json!({
        "status": "status_snapshot",
        "seq": NEXT_STATUS_SEQ.fetch_add(1, Ordering::SeqCst) + 1,
        "asr": { "loaded": loaded, "model": model, "device": device },
        "recording": false,
    })
}

/// 真实引擎状态快照（自愈对账）：任何"卡 loading"调它 → status_snapshot 纠偏
///
/// async + 阻塞池：`state()` 内含 HTTP 健康检查（端口不通时还会追加 TCP 探测与 fresh client
/// 诊断），同步执行会冻结主线程（启动 800ms 与每次窗口聚焦都会走到这里）。
#[tauri::command]
async fn rust_get_status(app: tauri::AppHandle) -> serde_json::Value {
    let snap = match tauri::async_runtime::spawn_blocking(build_status_snapshot).await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[status] 快照任务失败（按未加载上报，前端下轮对账自愈）: {e}");
            status_snapshot_value(false, String::new(), String::new())
        }
    };
    let _ = app.emit("sidecar://event", snap.clone());
    snap
}

/// 卸载当前 ASR 引擎（llama/sherpa 都清理），供前端「卸载」操作
///
/// async + 阻塞池：卸载含杀进程 + 等端口关闭（最长数秒），不可占主线程。
#[tauri::command]
async fn rust_unload_asr() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::inference::registry::registry().unload_active()?;
        // 双保险：即使 active 判定异常，也把两个引擎都停掉
        let _ = crate::inference::llama_server::global_engine().unload();
        crate::inference::sherpa_asr::global_engine().unload();
        Ok(serde_json::json!({ "ok": true, "loaded": false }))
    })
    .await
    .map_err(|e| format!("卸载任务失败: {e}"))?
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

/// 数据根信息（便携/安装判定 + 模型目录）——前端启动时覆盖 localStorage 旧值
#[tauri::command]
fn get_data_root_info(app: tauri::AppHandle) -> serde_json::Value {
    let portable = crate::data_root::is_portable(&app);
    let data_root = crate::data_root::get_data_root(&app);
    // 模型根：优先已保存的用户选择，否则便携/安装各自默认（与 setup 一致）
    let model_root = crate::data_root::read_saved_model_root_with(&app)
        .unwrap_or_else(|| crate::data_root::default_model_root_with(&app));
    serde_json::json!({
        "portable": portable,
        "data_root": data_root.display().to_string(),
        "model_root": model_root.display().to_string(),
    })
}

/// 检测推理框架（libs）安装状态
#[tauri::command]
fn check_runtime() -> serde_json::Value {
    inference::runtime_download::runtime_status()
}

/// 两步验证：① 文件检查（缺什么列清单）② 试启动（DLL 链能否真跑）——不触发下载
///
/// async + 阻塞池：试启动要起子进程并轮询等待（最长 6 秒），同步执行会冻结 UI。
/// 返回结构与同步版完全一致（前端 `FrameworkPanel` 按 state/error/missing 判别，无 try/catch，
/// 因此这里绝不 reject —— 任务异常降级为 `state: "error"`）。
#[tauri::command]
async fn rust_verify_runtime(framework: String) -> serde_json::Value {
    let fw = framework.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        inference::runtime_download::verify_runtime_full(&fw)
    })
    .await
    {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[runtime] 验证任务失败: {e}");
            serde_json::json!({
                "state": "error",
                "installed": false,
                "missing": [],
                "error": format!("验证任务失败: {e}"),
            })
        }
    }
}

/// 下载 + 解压推理框架运行时（libs）到 exe 旁 libs/
/// 复用模型下载机制（代理 env + reqwest + tar 解压），带进度事件
#[tauri::command]
async fn download_runtime(
    app: tauri::AppHandle,
    framework: String,
) -> Result<serde_json::Value, String> {
    let app2 = app.clone();
    let fw2 = framework.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        inference::runtime_download::download_runtime(&app2, &fw2)
    })
    .await
    .map_err(|e| format!("运行时下载线程失败: {e}"))?;
    if let Err(e) = &result {
        // 失败也发事件：全局清除下载态 + 记日志（面板不在时也不卡住）
        let _ = app.emit(
            "sidecar://event",
            serde_json::json!({
                "status": "runtime_download_error",
                "framework": framework,
                "msg": e,
            }),
        );
    }
    result?;
    Ok(serde_json::json!({ "ok": true, "framework": framework }))
}

/// 测试 TTS 模型加载（打印输入输出 tensor 名称）
///
/// async + 阻塞池：模型加载含起子进程 / 等就绪，不可占主线程。
/// 有 State → 保持返回 Result，业务失败仍是 Err（与原语义一致）。
#[tauri::command]
async fn rust_test_tts_model(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let registry = state.tts.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = registry.lock();
        let (_fw, name) = guard.load("Kokoro-v1_0", "cpu")?;
        Ok(serde_json::json!({"status": "loaded", "model": name, "device": "cpu"}))
    })
    .await
    .map_err(|e| format!("测试任务失败: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log_bridge::install();
    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Rust log:: 记录 → 前端运行日志（引擎层端口守卫/身份验证等细节可见）
            log_bridge::start_emitter(app.handle().clone());

            // ── 预热 ASR 引擎注册表（必须在「非异步上下文」完成首次初始化）──
            // 原因：注册表首次初始化会构造 LlamaServerEngine → 创建 reqwest::blocking::Client
            // （其内部自建 tokio Runtime）。若首次初始化发生在 async 命令体或 spawn_blocking 里，
            // tokio 会拒绝在该上下文析构 Runtime → panic（"Cannot drop a runtime ..."），
            // 后果是 rust_load_asr 在发 model_loading 事件之前中断 → 界面停在「加载中」直到超时。
            // 此处位于主线程 setup，仅建对象（不发网络请求、不起子进程），毫秒级。
            // 注：只影响「创建时机」，HTTP 调用的执行线程不变（仍在后台线程/阻塞池）。
            let _ = crate::inference::registry::registry();

            // 统一数据根：便携模式（exe旁data）或安装模式（AppData）
            // 模型根优先级：config.json 已保存的用户选择 > 数据根/models（便携/安装各自默认）
            let saved = crate::data_root::read_saved_model_root_with(app.handle());
            let root = saved.unwrap_or_else(|| crate::data_root::default_model_root_with(app.handle()));
            let _ = model_manager::set_model_root(&root.to_string_lossy());

            // 启动录音 worker + rdev 全局监听（幂等，热键链路依赖）
            hotkey::start_capslock_listener(app.handle().clone());

            // ── System Tray + 关闭 → 隐藏 ──
            crate::tray::init_tray(app.handle())?;
            if let Some(window) = app.get_webview_window("main") {
                let win = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
            }
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
            rust_load_asr,
            rust_get_status,
            rust_unload_asr,
            rust_transcribe_llama,
            check_runtime,
            rust_verify_runtime,
            get_data_root_info,
            download_runtime,
            crate::data_root::rust_storage_model_root,
            tts::commands::rust_load_tts_model,
            tts::commands::rust_synthesize,
            tts::commands::rust_set_tts_language,
            tts::commands::rust_unload_tts_model,
            tts::commands::rust_set_tts_clone_voice,
            tts::commands::rust_clear_tts_clone_voice,
            tts::commands::rust_list_tts_speakers,
            rust_test_tts_model,
            persistence::read_data_file,
            persistence::write_data_file,
            persistence::remove_data_file,
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
