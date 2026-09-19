//! Rust 原生模型管理器 — 替代 Python sidecar 的模型下载/管理
//!
//! 对应技术重构文档 Phase 2-3：`huggingface_hub` → `hf-hub` crate
//! 事件协议与 Python 侧完全一致（`sidecar://event`），前端 ModelsPanel 无需改动。
//! - 代理：写入 HTTP(S)_PROXY + NO_PROXY=localhost,127.0.0.1，reqwest `system-proxy` 自动读取
//!   `ENV_SCOPE_LOCK` 保证「写入环境变量 + build_sync」原子化，避免多线程并发建 Client 时的竞态。
//! - 镜像：`HFClientBuilder::endpoint()` 显式设置；`HF_ENDPOINT` 环境变量兜底
//! - Token：仅来自 config.json 的 huggingfaceToken（bootstrap 注入 CONFIG），无 env 回退

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use hf_hub::progress::{DownloadEvent, ProgressEvent, ProgressHandler};
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

// ── 注册表（对策 python-backend/voxflow/registry.py） ──

/// 主模型文件挑选策略
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilePolicy {
    /// 取最大的候选文件（GGUF；`uses_mmproj` 框架排除 mmproj）
    Largest,
    /// 优先非量化（`_q*` 视为 QDQ 量化），全量化时退回最大（ONNX）
    PreferUnquantized,
}

/// 框架描述符（引擎级元数据：文件发现 / 下载过滤 / 显存诊断）
///
/// **新增推理框架 = 加一条数据 + 实现引擎 + 注册一行**，不再需要改任何 match 分支。
/// `id` 是引擎注册键（与 `ModelSpec.framework`、registry 注册行一致）。
pub struct FrameworkSpec {
    /// 引擎注册键："gguf" | "onnx" | "sherpa"
    pub id: &'static str,
    /// 前端展示名（分组 / 标签 / 显存 JSON key）："llama" | "sherpa" | "torch"
    pub engine: &'static str,
    /// 运行时包键（RUNTIME_PACKAGES.framework）："gguf" | "onnx"
    pub runtime_key: &'static str,
    /// 主模型文件扩展名
    pub main_exts: &'static [&'static str],
    pub file_policy: FilePolicy,
    /// 是否附带 mmproj（llama 的视觉/音频投影塔）
    pub uses_mmproj: bool,
    /// 下载允许的量化文件模式（None = 不过滤）
    pub quant_allow: Option<&'static [&'static str]>,
    /// 显存诊断：常驻进程名（None = 无常驻进程）
    pub process_name: Option<&'static str>,
}

pub static FRAMEWORKS: &[FrameworkSpec] = &[
    FrameworkSpec {
        id: "gguf",
        engine: "llama",
        runtime_key: "gguf",
        main_exts: &[".gguf"],
        file_policy: FilePolicy::Largest,
        uses_mmproj: true,
        quant_allow: Some(&["*Q8_0.gguf"]),
        process_name: Some("llama-server"),
    },
    FrameworkSpec {
        id: "onnx",
        engine: "sherpa",
        runtime_key: "onnx",
        main_exts: &[".onnx"],
        file_policy: FilePolicy::PreferUnquantized,
        uses_mmproj: false,
        quant_allow: None,
        process_name: Some("sherpa-onnx-offline-websocket-server"),
    },
    FrameworkSpec {
        id: "sherpa",
        engine: "sherpa",
        runtime_key: "onnx",
        main_exts: &[".onnx"],
        file_policy: FilePolicy::PreferUnquantized,
        uses_mmproj: false,
        quant_allow: None,
        // TTS 合成是一次性子进程：无常驻进程可探
        process_name: None,
    },
];

/// 按引擎注册键查框架描述符
pub fn framework_spec(id: &str) -> Option<&'static FrameworkSpec> {
    FRAMEWORKS.iter().find(|f| f.id == id)
}

/// 主模型文件扩展名（未知框架 → 空表，调用方按「未找到」处理）
pub fn main_exts(framework: &str) -> &'static [&'static str] {
    framework_spec(framework).map(|f| f.main_exts).unwrap_or(&[])
}

/// 运行时包键（未知框架 → None）
pub fn runtime_key(framework: &str) -> Option<&'static str> {
    framework_spec(framework).map(|f| f.runtime_key)
}

/// 是否附带 mmproj（未知框架 → false）
pub fn uses_mmproj(framework: &str) -> bool {
    framework_spec(framework).map(|f| f.uses_mmproj).unwrap_or(false)
}

// ── 运行时配置 ──

struct RuntimeConfig {
    model_root: PathBuf,
    mirror: String,
    proxy: String,
    /// HF 下载 token（config.json 可见可管；空 = 匿名/回退 env）
    token: String,
}

fn default_model_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("AppData/Roaming/com.voxflow.app/models")
}

static CONFIG: once_cell::sync::Lazy<RwLock<RuntimeConfig>> =
    once_cell::sync::Lazy::new(|| {
        RwLock::new(RuntimeConfig {
            model_root: default_model_root(),
            mirror: String::new(),
            proxy: String::new(),
            token: String::new(),
        })
    });

/// 创建 HFClient 前必须持有的锁，保证「写入环境变量 + build_sync」原子化
pub static ENV_SCOPE_LOCK: once_cell::sync::Lazy<Mutex<()>> =
    once_cell::sync::Lazy::new(|| Mutex::new(()));

pub fn apply_proxy_env(proxy: &str) {
    let p = proxy.trim();
    let keys = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];
    if p.is_empty() {
        for k in keys {
            std::env::remove_var(k);
        }
        std::env::remove_var("NO_PROXY");
        std::env::remove_var("no_proxy");
    } else {
        for k in keys {
            std::env::set_var(k, p);
        }
        std::env::set_var("NO_PROXY", "localhost,127.0.0.1");
        std::env::set_var("no_proxy", "localhost,127.0.0.1");
    }
}

fn apply_mirror_env(endpoint: &str) {
    let e = endpoint.trim();
    if e.is_empty() {
        std::env::remove_var("HF_ENDPOINT");
    } else {
        std::env::set_var("HF_ENDPOINT", e);
    }
}

/// 设置模型根（运行时 CONFIG）。接受：
///   - 绝对路径（数据根外，用户自选外部目录）→ 原样
///   - 相对路径（如 "models" / "模型库B"）→ 相对数据根解析为绝对
/// 相对路径禁止 ".." 逃逸（防 config 手改跳出数据根）。无存在性校验（空目录合法）。
/// 返回解析后的绝对路径（调用方用于事件回传/展示）。
pub fn set_model_root(path: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("model root is empty".into());
    }
    let abs = if p.is_absolute() {
        p
    } else {
        // 相对路径 → 相对数据根解析；".." 逃逸拒绝
        if p.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(format!("model root 相对路径禁止 .. 逃逸: {}", p.display()));
        }
        crate::data_root::get_data_root_raw().join(p)
    };
    let mut cfg = CONFIG.write();
    cfg.model_root = abs.clone();
    Ok(abs)
}

pub fn set_mirror(endpoint: &str) {
    let mut cfg = CONFIG.write();
    cfg.mirror = endpoint.trim().to_string();
}

pub fn set_proxy(proxy: &str) -> String {
    let p = proxy.trim().to_string();
    let mut cfg = CONFIG.write();
    cfg.proxy = p.clone();
    p
}

pub fn set_token(token: &str) -> String {
    let t = token.trim().to_string();
    let mut cfg = CONFIG.write();
    cfg.token = t.clone();
    t
}

pub fn get_model_root() -> PathBuf {
    CONFIG.read().model_root.clone()
}
pub fn get_mirror() -> String {
    CONFIG.read().mirror.clone()
}
pub fn get_proxy() -> String {
    CONFIG.read().proxy.clone()
}
/// HF 下载 token：唯一来源 = config.json 的 models.huggingfaceToken（经 bootstrap 进入 CONFIG）。
/// 空 = 匿名下载（不设 token）。不读任何环境变量——删除软件无残留，配置只此一处。
pub fn config_token() -> String {
    CONFIG.read().token.trim().to_string()
}
pub fn model_dir(name: &str) -> PathBuf {
    resolve_download_dir(&get_model_root(), name)
}

// ── 状态检测 ──

/// 递归查找模型文件（最多 depth 层）
fn find_model_files(d: &Path, depth: usize, exts: &[&str]) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if depth > 2 { return found; }
    if let Ok(entries) = std::fs::read_dir(d) {
        for e in entries.flatten() {
            if let Ok(md) = e.metadata() {
                if md.is_file() && md.len() > 1_000_000 {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    if exts.iter().any(|ext| name.ends_with(ext)) {
                        found.push(e.path());
                    }
                } else if md.is_dir() && !e.file_name().to_string_lossy().starts_with('.') {
                    found.extend(find_model_files(&e.path(), depth + 1, exts));
                }
            }
        }
    }
    found
}

/// 查找主模型文件（策略来自框架描述符：扩展名 / 是否排除 mmproj / 量化偏好）
///
/// `PreferUnquantized`（ONNX）：优先返回 `model.onnx` / `model_fp16.onnx` 等标准模型，
/// 避开 `model_q*` 等 QDQ 量化模型 —— 历史上 `ort 2.0 + onnxruntime 1.28` 加载 Q8F16 QDQ
/// 会 `STATUS_ACCESS_VIOLATION` 崩溃；现虽改走 sherpa CLI，该偏好仍保留。
pub fn find_main_model_file(dir: &Path, framework: &str) -> Option<PathBuf> {
    let spec = framework_spec(framework)?;
    let files = find_model_files(dir, 0, spec.main_exts);
    match spec.file_policy {
        FilePolicy::Largest => files
            .into_iter()
            .filter(|f| {
                !spec.uses_mmproj
                    || !f
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_lowercase()
                        .contains("mmproj")
            })
            .max_by_key(|f| f.metadata().map(|m| m.len()).unwrap_or(0)),
        FilePolicy::PreferUnquantized => {
            let is_qdq = |p: &PathBuf| {
                p.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase()
                    .contains("_q")
            };
            if let Some(p) = files
                .iter()
                .filter(|p| !is_qdq(p))
                .max_by_key(|p| p.metadata().map(|m| m.len()).unwrap_or(0))
                .cloned()
            {
                return Some(p);
            }
            files.into_iter().max_by_key(|f| f.metadata().map(|m| m.len()).unwrap_or(0))
        }
    }
}

/// 查找 mmproj 文件（GGUF 多模态投影）
pub fn find_mmproj_file(dir: &Path) -> Option<PathBuf> {
    let files = find_model_files(dir, 0, &[".gguf"]);
    files.into_iter()
        .find(|f| f.file_name().unwrap_or_default().to_string_lossy().to_lowercase().contains("mmproj"))
}

/// 检查模型目录是否已下载完成
fn is_complete(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    // 检测 1：config.json 存在（PyTorch / GGUF 转换仓库常保留）
    if dir.join("config.json").exists() {
        return true;
    }
    // 检测 2：递归查找模型文件（扩展名来自框架描述符表）
    if FRAMEWORKS.iter().any(|f| !find_model_files(dir, 0, f.main_exts).is_empty()) {
        return true;
    }
    // 检测 3：HF 缓存 blobs（兼容 kokoro 等库自行下载到 hub/models--<name>/blobs/）
    let hub = dir.parent().map(|p| p.join("hub")).unwrap_or_default();
    let hf_name = format!(
        "models--{}",
        dir.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .replace('/', "--")
    );
    let blobs = hub.join(hf_name).join("blobs");
    if blobs.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&blobs) {
            for e in entries.flatten() {
                if let Ok(md) = e.metadata() {
                    if md.is_file() && md.len() > 10 * 1024 * 1024 {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn dir_size_bytes(dir: &Path) -> u64 {
    walkdir_size(dir)
}
fn walkdir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if let Ok(md) = e.metadata() {
                if md.is_file() {
                    total = total.saturating_add(md.len());
                } else if md.is_dir() {
                    total = total.saturating_add(walkdir_size(&e.path()));
                }
            }
        }
    }
    total
}

#[cfg(windows)]
fn free_bytes_for_root() -> Option<u64> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    let root = get_model_root();
    // 取盘符根目录，如 D:\
    let drive = root
        .ancestors()
        .find(|p| p.is_absolute() && p.parent().is_none())
        .unwrap_or(Path::new("C:\\"));
    let wide: Vec<u16> = OsStr::new(drive).encode_wide().chain(Some(0)).collect();
    let mut free: u64 = 0;
    let mut total: u64 = 0;
    let mut total_free: u64 = 0;
    let ok = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free as *mut u64,
            &mut total as *mut u64,
            &mut total_free as *mut u64,
        )
    };
    if ok != 0 { Some(free) } else { None }
}
#[cfg(not(windows))]
fn free_bytes_for_root() -> Option<u64> {
    None
}

// ── 下载管理 ──

static ACTIVE: once_cell::sync::Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

pub fn is_downloading(name: &str) -> bool {
    ACTIVE.lock().contains_key(name)
}

/// 迁移旧布局：E2E 模型曾下载到展示名目录（如 models/Matcha-zh-baker），
/// 现在引擎找引擎目录名（matcha-icefall-zh-baker）。应用启动时调用一次，
/// 把旧目录完整迁移到新目录名，避免用户重新下载。
pub fn start_download(app: AppHandle, name: &str) -> Result<(), String> {
    let spec = crate::tts::spec::ModelSpec::find(name)
        .ok_or_else(|| format!("unknown model: {name}"))?;
    if !spec.available {
        return Err(format!("engine not available yet: {}", spec.name));
    }

    // 迁移旧布局：E2E 模型曾下载到展示名目录（如 models/Matcha-zh-baker），
    // 现在引擎找引擎目录名（matcha-icefall-zh-baker）。若旧目录已存在且完整，
    // 直接迁移到新目录名并返回“已就绪”，避免用户重新下载。
    let root = get_model_root();
    let new_dir = resolve_download_dir(&root, &spec.name);
    let old_dir = root.join(&spec.name);
    if old_dir != new_dir && old_dir.is_dir() && !new_dir.exists() {
        if is_complete(&old_dir) {
            if std::fs::rename(&old_dir, &new_dir).is_ok() {
                eprintln!("[model] migrated {} -> {}", old_dir.display(), new_dir.display());
                let _ = app.emit(
                    "sidecar://event",
                    json!({"status": "model_downloaded", "model": spec.name, "path": new_dir.display().to_string()}),
                );
                emit_models_state(&app);
                return Ok(());
            }
        }
    }
    if let Some(free) = free_bytes_for_root() {
        let need = (spec.size_gb * 1024f64.powi(3)) as u64;
        if free < need {
            return Err(format!(
                "disk full: need ~{}GB, free {:.1}GB",
                spec.size_gb,
                free as f64 / 1024f64.powi(3)
            ));
        }
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = ACTIVE.lock();
        if active.contains_key(spec.name) {
            return Ok(());
        }
        active.insert(spec.name.to_string(), cancel.clone());
    }
    let app2 = app.clone();
    let name_owned = spec.name.to_string();
    thread::Builder::new()
        .name(format!("dl-{name_owned}"))
        .spawn(move || run_download(app2, spec, cancel))
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn request_cancel(name: &str) -> bool {
    if let Some(flag) = ACTIVE.lock().get(name) {
        flag.store(true, Ordering::SeqCst);
        return true;
    }
    false
}

pub fn delete_model(name: &str) -> Result<u64, String> {
    let _ = crate::tts::spec::ModelSpec::find(name).ok_or_else(|| format!("unknown model: {name}"))?;
    if is_downloading(name) {
        return Err(format!("downloading: {name}"));
    }
    let root = get_model_root();
    // 删除目标目录：优先引擎目录名，同时兼容旧布局展示名残留（如 Kokoro-v1_1）
    let dir = resolve_download_dir(&root, name);
    let legacy_dir = root.join(name);
    if !dir.exists() && legacy_dir != dir && legacy_dir.exists() {
        // 旧布局残留：删展示名目录
        let freed = dir_size_bytes(&legacy_dir);
        std::fs::remove_dir_all(&legacy_dir).map_err(|e| e.to_string())?;
        return Ok(freed);
    }
    if !dir.exists() {
        return Err(format!("not found: {name}"));
    }
    let freed = dir_size_bytes(&dir);
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(freed)
}

// ── Progress 回调 ──

/// 下载取消标记：作为 panic payload 中断 hf_hub 下载。
/// hf_hub 的 progress 回调无法直接中断下载，只能通过 panic 跳出；
/// 用类型化 payload + downcast 判定取消，比匹配字符串可靠。
#[derive(Debug)]
struct DownloadCancelled;

struct IpcProgress {
    app: AppHandle,
    model: String,
    cancel: Arc<AtomicBool>,
    state: Mutex<ProgressState>,
}
struct ProgressState {
    total_bytes: u64,
    files: HashMap<String, (u64, u64)>,
    last_emit: std::time::Instant,
}
impl IpcProgress {
    fn new(app: AppHandle, model: String, cancel: Arc<AtomicBool>) -> Self {
        Self {
            app,
            model,
            cancel,
            state: Mutex::new(ProgressState {
                total_bytes: 0,
                files: HashMap::new(),
                last_emit: std::time::Instant::now() - std::time::Duration::from_secs(10),
            }),
        }
    }
    fn emit(&self, file: Option<String>, downloaded: u64, total: u64) {
        let percent = if total > 0 {
            Some((downloaded as f64 / total as f64 * 100.0 * 10.0).round() / 10.0)
        } else {
            None
        };
        let payload = json!({
            "status": "model_download_progress",
            "model": self.model,
            "file": file,
            "downloaded_bytes": downloaded,
            "total_bytes": if total > 0 { Value::Number(total.into()) } else { Value::Null },
            "percent": percent,
        });
        let _ = self.app.emit("sidecar://event", payload);
    }
}
impl ProgressHandler for IpcProgress {
    fn on_progress(&self, event: &ProgressEvent) {
        if self.cancel.load(Ordering::Relaxed) {
            std::panic::panic_any(DownloadCancelled);
        }
        match event {
            ProgressEvent::Download(DownloadEvent::Start { total_bytes, .. }) => {
                let mut s = self.state.lock();
                s.total_bytes = *total_bytes;
            }
            ProgressEvent::Download(DownloadEvent::Progress { files }) => {
                let mut s = self.state.lock();
                for f in files {
                    s.files.insert(f.filename.clone(), (f.bytes_completed, f.total_bytes));
                }
                let now = std::time::Instant::now();
                if now.duration_since(s.last_emit) < std::time::Duration::from_millis(200) {
                    return;
                }
                s.last_emit = now;
                let downloaded: u64 = s.files.values().map(|(c, _)| *c).sum();
                let total = s.total_bytes;
                let cur = files
                    .iter()
                    .find(|f| f.bytes_completed < f.total_bytes)
                    .map(|f| {
                        Path::new(&f.filename)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or(&f.filename)
                            .to_string()
                    })
                    .or_else(|| {
                        files.last().map(|f| {
                            Path::new(&f.filename)
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or(&f.filename)
                                .to_string()
                        })
                    });
                drop(s);
                self.emit(cur, downloaded, total);
            }
            ProgressEvent::Download(DownloadEvent::AggregateProgress {
                bytes_completed,
                total_bytes,
                ..
            }) => {
                let mut s = self.state.lock();
                let now = std::time::Instant::now();
                if now.duration_since(s.last_emit) < std::time::Duration::from_millis(200) {
                    return;
                }
                s.last_emit = now;
                let total = if *total_bytes > 0 { *total_bytes } else { s.total_bytes };
                drop(s);
                self.emit(None, *bytes_completed, total);
            }
            ProgressEvent::Download(DownloadEvent::Complete) => {
                let s = self.state.lock();
                let downloaded: u64 = s.files.values().map(|(c, _)| *c).sum();
                let total = s.total_bytes;
                drop(s);
                self.emit(None, downloaded, total);
            }
            _ => {}
        }
    }
}

fn build_client_sync() -> Result<hf_hub::HFClientSync, String> {
    let (mirror, proxy) = {
        let cfg = CONFIG.read();
        (cfg.mirror.clone(), cfg.proxy.clone())
    };
    let token = crate::model_manager::config_token();
    let _env_guard = ENV_SCOPE_LOCK.lock();
    apply_proxy_env(&proxy);
    apply_mirror_env(&mirror);
    let mut builder = hf_hub::HFClient::builder();
    if !mirror.trim().is_empty() {
        builder = builder.endpoint(mirror.trim());
    }
    let t = token.trim();
    if !t.is_empty() {
        builder = builder.token(t);
    }
    builder.build_sync().map_err(|e| e.to_string())
}

fn run_download(app: AppHandle, spec: &'static crate::tts::spec::ModelSpec, cancel: Arc<AtomicBool>) {
    let name = spec.name.to_string();
    // 下载目标目录：E2E 模型用引擎目录名（与 TTS 引擎查找一致）
    let dest = resolve_download_dir(&get_model_root(), &name);
    let _ = app.emit(
        "sidecar://event",
        json!({ "status": "model_download_started", "model": name.clone() }),
    );
    emit_models_state(&app);
    let result: Result<PathBuf, String> = (|| {
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        // 优先从 GitHub releases 下载（无需 HF 认证，速度快）
        if let Some(url) = spec.github_release {
            return download_github_release(url, &dest, &name, &app, &cancel);
        }
        // 回退到 HuggingFace
        let client = build_client_sync()?;
        let (owner, repo_name) = hf_hub::split_id(spec.repo);
        let handler = IpcProgress::new(app.clone(), name.clone(), cancel.clone());
        let progress = hf_hub::progress::Progress::new(handler);
        // GGUF 模型只下载 Q8_0 量化版（模型 + mmproj），跳过 bf16 全精度与 safetensors 原始版
        // （bf16 单个 4G+，全量 snapshot 会白白下载 6G+；llama-server 只用 Q8_0）
        let allow_q8: Option<Vec<String>> = framework_spec(spec.framework)
            .and_then(|f| f.quant_allow)
            .map(|pats| pats.iter().map(|p| p.to_string()).collect());
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client
                .model(owner, repo_name)
                .snapshot_download()
                .maybe_allow_patterns(allow_q8)
                .local_dir(dest.clone())
                .max_workers(2)
                .progress(progress)
                .send()
        }));
        match outcome {
            Ok(Ok(p)) => Ok(p),
            Ok(Err(e)) => {
                let msg = e.to_string();
                // 若 hf_hub 把取消 panic 转成了 Err，或取消标志已置位 → 视为取消
                if cancel.load(Ordering::Relaxed) {
                    Err("__CANCELLED__".into())
                } else {
                    Err(msg)
                }
            }
            Err(payload) => {
                if payload.downcast_ref::<DownloadCancelled>().is_some() {
                    Err("__CANCELLED__".into())
                } else {
                    Err("download panicked".into())
                }
            }
        }
    })();
    ACTIVE.lock().remove(&name);
    match result {
        Ok(p) => {
            // ZipVoice 需要额外下载 vocoder（vocos_24khz.onnx）到模型根目录
            if spec.name == "ZipVoice-distill" {
                let vocoder_dest = crate::model_manager::get_model_root().join("vocos_24khz.onnx");
                if !vocoder_dest.exists() {
                    let _ = app.emit(
                        "sidecar://event",
                        json!({ "status": "model_download_progress", "model": "ZipVoice-distill", "progress": 0u32 }),
                    );
                    let vocoder_url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos_24khz.onnx";
                    match download_single_file(vocoder_url, &vocoder_dest, "vocos_24khz.onnx", &app, &cancel) {
                        Ok(()) => eprintln!("[download] vocoder downloaded: {}", vocoder_dest.display()),
                        Err(e) => eprintln!("[download] vocoder download failed: {e}"),
                    }
                }
            }
            let size_bytes = dir_size_bytes(&p);
            let _ = app.emit(
                "sidecar://event",
                json!({ "status": "model_downloaded", "model": name.clone(), "path": p.display().to_string(), "size_bytes": size_bytes }),
            );
        }
        Err(e) if e == "__CANCELLED__" => {
            let _ = app.emit(
                "sidecar://event",
                json!({ "status": "model_download_cancelled", "model": name.clone() }),
            );
        }
        Err(e) => {
            if cancel.load(Ordering::Relaxed) {
                let _ = app.emit(
                    "sidecar://event",
                    json!({ "status": "model_download_cancelled", "model": name.clone() }),
                );
            } else {
                let _ = app.emit(
                    "sidecar://event",
                    json!({ "status": "model_download_error", "model": name.clone(), "msg": e }),
                );
            }
        }
    }
    emit_models_state(&app);
}

/// 从 GitHub releases 下载 tar.bz2 并解压到目标目录
fn download_github_release(
    url: &str,
    dest: &Path,
    model_name: &str,
    app: &AppHandle,
    cancel: &AtomicBool,
) -> Result<PathBuf, String> {
    use std::io::Read;
    let proxy = { CONFIG.read().proxy.clone() };
    let _env_guard = ENV_SCOPE_LOCK.lock();
    apply_proxy_env(&proxy);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .build()
        .map_err(|e| format!("HTTP client build failed: {e}"))?;
    let mut resp = client.get(url).send().map_err(|e| format!("HTTP GET failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {}", resp.status(), url));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut buf = Vec::with_capacity(total as usize);
    let mut last_emit = std::time::Instant::now();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("__CANCELLED__".into());
        }
        let n = resp.read(&mut chunk).map_err(|e| format!("read error: {e}"))?;
        if n == 0 { break; }
        buf.extend_from_slice(&chunk[..n]);
        downloaded += n as u64;
        if last_emit.elapsed().as_millis() > 500 {
            let pct = if total > 0 { (downloaded as f64 / total as f64 * 100.0) as u32 } else { 0 };
            let _ = app.emit(
                "sidecar://event",
                json!({ "status": "model_download_progress", "model": model_name, "progress": pct, "downloaded": downloaded, "total": total }),
            );
            last_emit = std::time::Instant::now();
        }
    }
    let _ = app.emit(
        "sidecar://event",
        json!({ "status": "model_download_progress", "model": model_name, "progress": 100u32 }),
    );
    // 写临时文件 + tar xjf 解压
    let tmp_bz2 = dest.join("_download.tar.bz2");
    std::fs::write(&tmp_bz2, &buf).map_err(|e| format!("write tmp: {e}"))?;
    // 解压阶段：发"解压中"事件（进度无百分比，防 UI 停在 100% 像卡死）
    let _ = app.emit(
        "sidecar://event",
        json!({ "status": "model_download_extracting", "model": model_name }),
    );
    eprintln!("[download] extracting {} bytes to {}", buf.len(), dest.display());
    // 解压：7z → bsdtar（System32 全路径）→ tar 回退（避免 GNU tar 把 D: 当远程主机）
    crate::inference::runtime_download::extract_archive(&tmp_bz2, dest)?;
    let _ = std::fs::remove_file(&tmp_bz2);
    // tar 解压后：把模型文件从子目录移到 dest 根
    // GitHub tarball 通常是 `sherpa-onnx-xxx/model.onnx` 格式
    // 需要移到 `dest/model.onnx`
    let entries: Vec<_> = std::fs::read_dir(dest)
        .map_err(|e| format!("read_dir: {e}"))?
        .filter_map(|e| e.ok())
        .collect();
    // 找到包含 .onnx 文件的子目录（忽略 README.md 等杂项）
    for entry in &entries {
        if !entry.path().is_dir() { continue; }
        let sub = entry.path();
        let has_onnx = std::fs::read_dir(&sub)
            .map(|rd| rd.filter_map(|e| e.ok()).any(|e| {
                e.path().extension().map(|x| x == "onnx").unwrap_or(false)
            }))
            .unwrap_or(false);
        if has_onnx {
            // 把子目录里的所有文件移到 dest
            for f in std::fs::read_dir(&sub).map_err(|e| format!("read_dir sub: {e}"))? {
                let f = f.map_err(|e| e.to_string())?;
                let target = dest.join(f.file_name());
                std::fs::rename(f.path(), &target).map_err(|e| format!("move: {e}"))?;
            }
            let _ = std::fs::remove_dir(&sub);
            break;
        }
    }
    Ok(dest.to_path_buf())
}

/// 下载单个文件（不解压，用于 vocoder 等依赖）
fn download_single_file(
    url: &str,
    dest: &Path,
    _label: &str,
    _app: &AppHandle,
    cancel: &AtomicBool,
) -> Result<(), String> {
    use std::io::Read;
    let proxy = { CONFIG.read().proxy.clone() };
    let _env_guard = ENV_SCOPE_LOCK.lock();
    apply_proxy_env(&proxy);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let mut resp = client.get(url).send().map_err(|e| format!("HTTP GET: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let mut buf = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) { return Err("__CANCELLED__".into()); }
        let n = resp.read(&mut chunk).map_err(|e| format!("read: {e}"))?;
        if n == 0 { break; }
        buf.extend_from_slice(&chunk[..n]);
    }
    std::fs::write(dest, &buf).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

// ── models_state 事件 ──


/// 语言模式 → 前端字符串（描述符能力字段）
fn language_mode_str(m: crate::tts::spec::LanguageMode) -> &'static str {
    use crate::tts::spec::LanguageMode as L;
    match m {
        L::Auto => "auto",
        L::Fixed => "fixed",
        L::Select => "select",
        L::Cloning => "cloning",
    }
}

/// 音色模式 → 前端 JSON（描述符能力字段）
fn voice_mode_json(v: crate::tts::spec::VoiceMode) -> Value {
    use crate::tts::spec::VoiceMode as V;
    match v {
        V::Fixed => json!({ "type": "fixed" }),
        V::Preset(p) => json!({
            "type": "preset",
            "count": p.count,
            "per_language": p.per_language,
        }),
        V::Clone(c) => json!({
            "type": "clone",
            "requires_text": c.requires_text,
            "overrides_preset": c.overrides_preset,
        }),
        V::PresetAndClone(p, c) => json!({
            "type": "preset_and_clone",
            "count": p.count,
            "per_language": p.per_language,
            "requires_text": c.requires_text,
        }),
    }
}

/// 解析模型真实目录：展示名（如 "Kokoro-v1_0"）→ 引擎目录（"kokoro-multi-lang-v1_0"）。
/// 目录存在则返回它，否则回退到 default（描述符查找，无 e2e_registry 依赖）。
#[allow(dead_code)] // 测试专用
fn resolve_sherpa_model_dir(root: &Path, name: &str, default: &Path) -> PathBuf {
    if let Some(spec) = crate::tts::spec::ModelSpec::find(name) {
        let engine_dir = root.join(spec.id);
        if engine_dir.exists() {
            return engine_dir;
        }
    }
    default.to_path_buf()
}

/// 计算模型下载/查找的目标目录：优先用描述符的引擎目录名（engine_id，
/// 与 TTS 引擎查找一致）；未收录模型回退到展示名目录。
/// 修复「下载到展示名目录但引擎找引擎目录名」的不一致。
fn resolve_download_dir(root: &Path, name: &str) -> PathBuf {
    // 1. 描述符（TTS 展示名 / 引擎 id / 目录名 归一化匹配）
    if let Some(spec) = crate::tts::spec::ModelSpec::find(name) {
        return root.join(spec.id);
    }
    root.join(name)
}

pub fn list_models_payload(kind: Option<&str>) -> Value {
    let root = get_model_root();
    let mirror = get_mirror();
    let proxy = get_proxy();
    let hub = root.join("hub");
    let _ = std::fs::create_dir_all(&hub);
    let mut items: Vec<Value> = Vec::new();
    for spec in crate::tts::spec::SPECS {
        if let Some(k) = kind {
            if spec.kind.as_str() != k {
                continue;
            }
        }
        // sherpa-onnx E2E 模型的目录名与展示名不同（如 Kokoro-v1_0 → kokoro-multi-lang-v1_0）
        // 统一用引擎目录名判定（与下载/删除/TTS 引擎一致）
        let real_dir = resolve_download_dir(&root, spec.name);
        let state = if is_downloading(spec.name) {
            "downloading"
        } else if is_complete(&real_dir) {
            "downloaded"
        } else {
            "not_downloaded"
        };
        let dir = real_dir;
        // 兼容旧布局残留：引擎目录不存在但展示名目录存在（如下载失败留了 Kokoro-v1_1）
        let legacy_dir = root.join(spec.name);
        let dir_exists = dir.is_dir() || (legacy_dir != dir && legacy_dir.is_dir());
        let mut obj = json!({
            "name": spec.name,
            "kind": spec.kind.as_str(),
            "format": runtime_key(spec.framework).unwrap_or(spec.framework),
            // 新增（只增不改）：前端据此分组/门禁，不再自行做 format→framework 推导
            "engine": framework_spec(spec.framework).map(|f| f.engine).unwrap_or(""),
            "runtime_key": runtime_key(spec.framework).unwrap_or(spec.framework),
            "repo": spec.repo,
            "size_gb": spec.size_gb,
            "description_zh": spec.description_zh,
            "description_en": spec.description_en,
            "available": spec.available,
            "cpu": spec.cpu,
            "quant": spec.quant,
            "path": dir.display().to_string(),
            "state": state,
            "dir_exists": dir_exists,
        });
        if state == "downloaded" {
            let bytes = dir_size_bytes(&dir);
            let gb = (bytes as f64 / 1024f64.powi(3) * 100.0).round() / 100.0;
            obj["size_on_disk_gb"] = json!(gb);
            // 附带主模型文件路径，方便前端直接加载
            if let Some(main_file) = find_main_model_file(&dir, spec.framework) {
                obj["model_path"] = json!(main_file.display().to_string());
                // GGUF 模型额外附带 mmproj 路径
                if uses_mmproj(spec.framework) {
                    if let Some(mmproj) = find_mmproj_file(&dir) {
                        obj["mmproj_path"] = json!(mmproj.display().to_string());
                    }
                }
            }
        }
        // 能力字段（描述符驱动，前端语言/克隆 UI 据此渲染；见方案 4.4 决策 A）
        obj["languages"] = json!(spec.languages);
        obj["language_mode"] = json!(language_mode_str(spec.language_mode));
        obj["voice_mode"] = json!(voice_mode_json(spec.voice_mode));
        obj["supports_clone"] = json!(matches!(
            spec.voice_mode,
            crate::tts::spec::VoiceMode::Clone(_) | crate::tts::spec::VoiceMode::PresetAndClone(..)
        ));
        items.push(obj);
    }
    let disk_free_gb = free_bytes_for_root().map(|b| (b as f64 / 1024f64.powi(3) * 10.0).round() / 10.0);
    json!({
        "status": "models_state",
        "model_root": root.display().to_string(),
        "mirror": mirror,
        "proxy": proxy,
        "disk_free_gb": disk_free_gb,
        "models": items,
    })
}

pub fn emit_models_state(app: &AppHandle) {
    let payload = list_models_payload(None);
    let _ = app.emit("sidecar://event", payload);
}

#[cfg(test)]
mod e2e_list_tests {
    use super::*;

    /// 决策 A 数据通路：models_state payload 为 TTS 模型携带描述符能力字段
    /// （前端语言/克隆 UI 的唯一来源，无需再调独立命令）
    #[test]
    fn test_models_state_carries_capability_fields() {
        let payload = list_models_payload(Some("tts"));
        let models = payload["models"].as_array().expect("models 数组");
        assert!(!models.is_empty(), "应有 TTS 模型");

        let kokoro = models
            .iter()
            .find(|m| m["name"] == "Kokoro-v1_0")
            .expect("应含 Kokoro-v1_0");
        assert_eq!(kokoro["language_mode"], "auto");
        assert_eq!(kokoro["languages"][0], "zh");
        assert_eq!(kokoro["voice_mode"]["type"], "preset");
        assert_eq!(kokoro["voice_mode"]["count"], 53);
        assert_eq!(kokoro["supports_clone"], false);

        // 前端数据契约（只增不改）：engine / runtime_key 由 Rust 下发，前端不再做 format→框架推导
        assert_eq!(kokoro["format"], "onnx");
        assert_eq!(kokoro["runtime_key"], "onnx");
        assert_eq!(kokoro["engine"], "sherpa");

        let zip = models
            .iter()
            .find(|m| m["name"] == "ZipVoice-distill")
            .expect("应含 ZipVoice-distill");
        assert_eq!(zip["language_mode"], "cloning");
        assert_eq!(zip["voice_mode"]["type"], "clone");
        assert_eq!(zip["voice_mode"]["requires_text"], true);
        assert_eq!(zip["supports_clone"], true);

        // 决策 6：Pocket 按不支持克隆处理（不再出现无效克隆卡）
        let pocket = models
            .iter()
            .find(|m| m["name"] == "PocketTTS-int8")
            .expect("应含 PocketTTS-int8");
        assert_eq!(pocket["voice_mode"]["type"], "fixed");
        assert_eq!(pocket["supports_clone"], false);

        // ASR 模型同样携带三字段（gguf → engine llama）
        let asr = list_models_payload(Some("asr"));
        let asr_models = asr["models"].as_array().expect("models 数组");
        let qwen = asr_models
            .iter()
            .find(|m| m["name"] == "Qwen3-ASR-0.6B")
            .expect("应含 Qwen3-ASR-0.6B");
        assert_eq!(qwen["format"], "gguf");
        assert_eq!(qwen["runtime_key"], "gguf");
        assert_eq!(qwen["engine"], "llama");
    }

    fn dev_root() -> PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/models")
    }

    #[test]
    fn test_resolve_sherpa_model_dir_kokoro() {
        let root = dev_root();
        let name = "Kokoro-v1_0";
        let default = root.join(name);
        let resolved = resolve_sherpa_model_dir(&root, name, &default);
        eprintln!("resolved: {}", resolved.display());
        assert!(resolved.exists(), "模型目录不存在: {}", resolved.display());
    }

    #[test]
    fn test_resolve_sherpa_model_dir_fallback() {
        let root = dev_root();
        let default = root.join("NoSuchModel");
        // 未知名称回退到默认目录
        let resolved = resolve_sherpa_model_dir(&root, "NoSuchModel", &default);
        assert_eq!(resolved, default);
    }

    #[test]
    fn test_resolve_download_dir_engine_name() {
        let root = dev_root();
        // 展示名 → 引擎目录名（与 TTS 引擎查找一致）
        let cases = [
            ("Matcha-zh-baker", "matcha-icefall-zh-baker"),
            ("matcha-icefall-zh-baker", "matcha-icefall-zh-baker"),
            ("Kokoro-v1_0", "kokoro-multi-lang-v1_0"),
            ("Kokoro-v1_1", "kokoro-multi-lang-v1_1"),
            ("Kokoro-en-v0_19", "kokoro-en-v0_19"),
            ("ZipVoice-distill", "sherpa-onnx-zipvoice-distill"),
            ("PocketTTS-int8", "sherpa-onnx-pocket-tts-int8"),
            ("Supertonic-3-int8", "sherpa-onnx-supertonic-3-tts-int8"),
            ("Kitten-nano-en", "kitten-nano-en-v0_1-fp16"),
            // ASR 模型有 engine_dir → 引擎目录名（llama-server 查找一致）
            ("Qwen3-ASR-0.6B", "qwen3-asr-0.6b-gguf"),
            // sherpa ASR 模型 → 引擎目录名
            ("SenseVoice-int8", "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"),
            ("Paraformer-zh-small", "sherpa-onnx-paraformer-zh-small-2024-03-09"),
        ];
        for (input, expect) in cases {
            let resolved = resolve_download_dir(&root, input);
            let name = resolved.file_name().unwrap().to_string_lossy().to_string();
            assert_eq!(name, expect, "input={input}");
        }
    }
}
