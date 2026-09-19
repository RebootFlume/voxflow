//! Rust 原生模型管理器 — 模型下载/清单/删除
//!
//! - 下载：统一走 `crate::net`（流式 + 断点续传 + 原子 + 取消 + 重试）
//!   · GitHub release 资产：整包下载后解压
//!   · HuggingFace：按模型的**精选条目**（`DownloadEntry.files` 精确文件名）逐个直链下载
//! - 代理：写入 HTTP(S)_PROXY + NO_PROXY=localhost,127.0.0.1；`ENV_SCOPE_LOCK` 保证
//!   「写环境变量 + 建 client」原子化，避免并发建 Client 的竞态
//! - Token：仅来自 config.json 的 huggingfaceToken（bootstrap 注入 CONFIG），且**只发 huggingface.co**
//! - 记账：下载完成写 `.voxflow-manifest.json`（条目 id + repo@revision + 文件与大小）

use std::collections::HashMap;
use crate::tts::spec::DownloadSource;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

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

/// 框架描述符（引擎级元数据：文件发现 / 显存诊断）
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
        process_name: Some("llama-server"),
    },
    FrameworkSpec {
        id: "onnx",
        engine: "sherpa",
        runtime_key: "onnx",
        main_exts: &[".onnx"],
        file_policy: FilePolicy::PreferUnquantized,
        uses_mmproj: false,
        process_name: Some("sherpa-onnx-offline-websocket-server"),
    },
    FrameworkSpec {
        id: "sherpa",
        engine: "sherpa",
        runtime_key: "onnx",
        main_exts: &[".onnx"],
        file_policy: FilePolicy::PreferUnquantized,
        uses_mmproj: false,
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

/// 指定目录所在卷的可用字节（Windows；其他平台 None = 不做预检）
#[cfg(windows)]
pub fn free_bytes_for_dir(path: &Path) -> Option<u64> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    let root = path;
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
pub fn free_bytes_for_dir(_path: &Path) -> Option<u64> {
    None
}

fn free_bytes_for_root() -> Option<u64> {
    free_bytes_for_dir(&get_model_root())
}

// ── 下载管理 ──

/// 进行中的下载：模型名 → (取消标志, 目标条目 id)
static ACTIVE: once_cell::sync::Lazy<Mutex<HashMap<String, (Arc<AtomicBool>, String)>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

pub fn is_downloading(name: &str) -> bool {
    ACTIVE.lock().contains_key(name)
}

/// 迁移旧布局：E2E 模型曾下载到展示名目录（如 models/Matcha-zh-baker），
/// 现在引擎找引擎目录名（matcha-icefall-zh-baker）。应用启动时调用一次，
/// 把旧目录完整迁移到新目录名，避免用户重新下载。
/// 开始下载；`entry_id` 为空 = 默认条目（无条目的模型忽略该参数）
pub fn start_download(app: AppHandle, name: &str, entry_id: &str) -> Result<(), String> {
    let spec = crate::tts::spec::ModelSpec::find(name)
        .ok_or_else(|| format!("unknown model: {name}"))?;
    if !spec.available {
        return Err(format!("engine not available yet: {}", spec.name));
    }
    let target_entry = if spec.entries.is_empty() {
        None
    } else {
        let entry = if entry_id.is_empty() {
            spec.default_entry()
        } else {
            spec.entry(entry_id)
        };
        Some(entry.ok_or_else(|| format!("unknown entry: {entry_id}"))?)
    };

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
        // 峰值 = 下载归档 + 解压产物（解压期间两者并存）≈ 2× 体积；
        // 有条目时按条目体积（如换 bf16 解码器会更大）
        let need_gb = target_entry.map(|e| e.size_gb).unwrap_or(spec.size_gb) * 2.0;
        let need = (need_gb * 1024f64.powi(3)) as u64;
        if free < need {
            return Err(format!(
                "disk full: need ~{need_gb:.1}GB, free {:.1}GB",
                free as f64 / 1024f64.powi(3)
            ));
        }
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = ACTIVE.lock();
        if active.contains_key(spec.name) {
            return Ok(()); // 同模型已在下载（含切条目），忽略重复点击
        }
        active.insert(spec.name.to_string(), (cancel.clone(), entry_id.to_string()));
    }
    let app2 = app.clone();
    let name_owned = spec.name.to_string();
    let entry_owned = entry_id.to_string();
    thread::Builder::new()
        .name(format!("dl-{name_owned}"))
        .spawn(move || run_download(app2, spec, entry_owned, cancel))
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn request_cancel(name: &str) -> bool {
    if let Some((flag, _)) = ACTIVE.lock().get(name) {
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
    // 顺带清理该模型的下载临时物（`.tmp/<name>.*`：中断留下的 .part / 解压失败的归档）
    let tmp_dir = root.join(".tmp");
    if let Ok(entries) = std::fs::read_dir(&tmp_dir) {
        let prefix = format!("{name}.");
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
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

// ── 模型目录清单（manifest）："这个目录装的是哪条 + 装了哪些文件"的唯一真源 ──

/// 清单文件名（模型目录内，隐藏文件）
pub const MANIFEST_FILE: &str = ".voxflow-manifest.json";

#[derive(Debug, Clone)]
pub struct Manifest {
    /// 当前安装的精选条目 id
    pub entry: String,
    pub repo: String,
    pub revision: String,
    /// (相对模型目录的路径, 字节数)
    pub files: Vec<(String, u64)>,
}

pub fn manifest_path(dir: &Path) -> PathBuf {
    dir.join(MANIFEST_FILE)
}

/// 读清单（缺失 / 损坏 → None，调用方按旧式目录处理）
pub fn read_manifest(dir: &Path) -> Option<Manifest> {
    let raw = std::fs::read_to_string(manifest_path(dir)).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let entry = v.get("entry")?.as_str()?.to_string();
    let files = v
        .get("files")?
        .as_array()?
        .iter()
        .filter_map(|f| {
            Some((
                f.get("path")?.as_str()?.to_string(),
                f.get("size").and_then(|x| x.as_u64()).unwrap_or(0),
            ))
        })
        .collect();
    Some(Manifest {
        entry,
        repo: v.get("repo").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
        revision: v.get("revision").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
        files,
    })
}

/// 原子写清单（临时文件 + rename；失败即报错，不留下半个清单）
pub fn write_manifest(dir: &Path, m: &Manifest) -> Result<(), String> {
    let files: Vec<Value> = m
        .files
        .iter()
        .map(|(path, size)| json!({ "path": path, "size": size }))
        .collect();
    let payload = json!({
        "entry": m.entry,
        "repo": m.repo,
        "revision": m.revision,
        "files": files,
    });
    let tmp = dir.join(format!("{MANIFEST_FILE}.tmp"));
    let text = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("write manifest: {e}"))?;
    std::fs::rename(&tmp, manifest_path(dir)).map_err(|e| format!("rename manifest: {e}"))
}

/// 该模型当前安装的条目：manifest 优先 → 默认条目（无条目的模型 → None）
pub fn active_entry_of(
    spec: &'static crate::tts::spec::ModelSpec,
) -> Option<&'static crate::tts::spec::DownloadEntry> {
    if spec.entries.is_empty() {
        return None;
    }
    let dir = resolve_download_dir(&get_model_root(), spec.name);
    if let Some(m) = read_manifest(&dir) {
        if let Some(e) = spec.entry(&m.entry) {
            return Some(e);
        }
    }
    // 旧式目录（无 manifest）：按"文件是否真的在"判定，避免 active 指向未安装的条目
    if let Some(def) = spec.default_entry() {
        if entry_installed(&dir, spec, def.id) {
            return Some(def);
        }
    }
    spec.entries.iter().find(|e| entry_installed(&dir, spec, e.id))
}

/// 条目是否已完整落盘：清单声明过的文件按 size 核，未记录 size 的只核存在
pub fn entry_installed(
    dir: &Path,
    spec: &'static crate::tts::spec::ModelSpec,
    entry_id: &str,
) -> bool {
    let Some(entry) = spec.entry(entry_id) else {
        return false;
    };
    if entry.files.is_empty() {
        return false;
    }
    let manifest = read_manifest(dir);
    for f in entry.files {
        let path = dir.join(f.name);
        if !path.is_file() {
            return false;
        }
        if let Some(m) = &manifest {
            if m.entry == entry_id {
                if let Some((_, size)) = m.files.iter().find(|(name, _)| name == f.name) {
                    if *size > 0 {
                        let actual = std::fs::metadata(&path).map(|md| md.len()).unwrap_or(0);
                        if actual != *size {
                            return false;
                        }
                    }
                }
            }
        }
    }
    true
}

/// 加载端取主文件：条目声明优先 → 退回框架策略（无条目的模型）
pub fn main_model_file(
    spec: &'static crate::tts::spec::ModelSpec,
    dir: &Path,
) -> Option<PathBuf> {
    if let Some(entry) = active_entry_of(spec) {
        if let Some(name) = entry.file(crate::tts::spec::FileRole::Main) {
            let path = dir.join(name);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    find_main_model_file(dir, spec.framework)
}

/// 加载端取 mmproj：条目声明优先 → 退回旧策略
pub fn mmproj_file(spec: &'static crate::tts::spec::ModelSpec, dir: &Path) -> Option<PathBuf> {
    if let Some(entry) = active_entry_of(spec) {
        if let Some(name) = entry.file(crate::tts::spec::FileRole::Mmproj) {
            let path = dir.join(name);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    find_mmproj_file(dir)
}

// ── HuggingFace 逐文件下载（条目驱动；不用任何 HF 客户端库）──

/// `owner/name` + revision + 仓库内相对路径 → 直链（路径分段百分号编码）
pub fn hf_file_url(repo: &str, revision: &str, name: &str) -> String {
    let encoded: Vec<String> = name.split('/').map(encode_path_segment).collect();
    format!(
        "https://huggingface.co/{repo}/resolve/{revision}/{}",
        encoded.join("/")
    )
}

/// 路径分段百分号编码（保留 unreserved 与 RFC3986 子分隔符；HF 文件名常见空格/中文）
fn encode_path_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for b in seg.bytes() {
        let c = b as char;
        let keep = c.is_ascii_alphanumeric()
            || matches!(
                c,
                '-' | '_' | '.' | '~' | '(' | ')' | '!' | '*' | '\'' | '$' | ',' | ';' | '=' | ':'
                    | '@' | '&' | '+'
            );
        if keep {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 是否给该 URL 附 HF token：**只发 huggingface.co**（绝不泄漏给 GitHub 等其他 host）
pub fn hf_auth_header(url: &str, token: &str) -> Option<(&'static str, String)> {
    let t = token.trim();
    if t.is_empty() || !url.starts_with("https://huggingface.co/") {
        return None;
    }
    Some(("Authorization", format!("Bearer {t}")))
}

/// HEAD 取文件大小（失败 → Err；仅用于进度权重，不阻断下载）
fn head_size(client: &reqwest::blocking::Client, url: &str) -> Result<u64, String> {
    let resp = client
        .head(url)
        .send()
        .map_err(|e| format!("HEAD failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HEAD {}", resp.status()));
    }
    Ok(resp.content_length().unwrap_or(0))
}

/// 按条目下载该组文件并落账 manifest（HF 源）
fn download_entry_files(
    app: &AppHandle,
    spec: &'static crate::tts::spec::ModelSpec,
    entry: &'static crate::tts::spec::DownloadEntry,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let crate::tts::spec::DownloadSource::HuggingFace { repo, revision } = spec.source else {
        return Err(format!("{}：条目下载要求 HuggingFace 源", spec.name));
    };
    let dir = resolve_download_dir(&get_model_root(), spec.name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let client = build_download_client()?;
    let urls: Vec<String> = entry
        .files
        .iter()
        .map(|f| hf_file_url(repo, revision, f.name))
        .collect();
    // 体积权重：HEAD 失败不阻断（退化为该文件停在区间起点，只报字节数）
    let head_sizes: Vec<Option<u64>> = urls.iter().map(|u| head_size(&client, u).ok()).collect();
    let weighted = head_sizes.iter().all(|s| s.is_some());
    let total: u64 = head_sizes.iter().filter_map(|s| *s).sum();
    let mut spans: Vec<(u32, u32)> = Vec::with_capacity(urls.len());
    let mut cursor = 0u32;
    for size in &head_sizes {
        if weighted && total > 0 {
            let w = (size.unwrap_or(0) as f64 / total as f64 * 100.0).round() as u32;
            let end = (cursor + w).min(100);
            spans.push((cursor, end));
            cursor = end;
        } else {
            spans.push((cursor, cursor));
        }
    }
    if let Some(last) = spans.last_mut() {
        last.1 = 100;
    }

    let token = config_token();
    let mut manifest_files: Vec<(String, u64)> = Vec::with_capacity(entry.files.len());
    for ((file, url), (span_start, span_end)) in entry.files.iter().zip(&urls).zip(&spans) {
        let dest = dir.join(file.name);
        let (s, e) = (*span_start, *span_end);
        let on_progress = |downloaded: u64, total: Option<u64>| {
            let pct = match total {
                Some(t) if t > 0 => {
                    s + ((e.saturating_sub(s)) as f64 * (downloaded as f64 / t as f64)) as u32
                }
                _ => s,
            };
            let _ = app.emit(
                "sidecar://event",
                json!({
                    "status": "model_download_progress",
                    "model": spec.name,
                    "progress": pct,
                    "downloaded": downloaded,
                    "total": total.unwrap_or(0),
                }),
            );
        };
        let headers: Vec<(&str, String)> = hf_auth_header(url, &token).into_iter().collect();
        let written = crate::net::download(
            &client,
            &crate::net::Download {
                url,
                dest: &dest,
                on_progress: Some(&on_progress),
                cancel: Some(&cancel),
                headers: &headers,
            },
        )?;
        manifest_files.push((file.name.to_string(), written));
    }
    // 先落账（此后的目录状态可自证），再清理旧条目独有的文件
    write_manifest(
        &dir,
        &Manifest {
            entry: entry.id.to_string(),
            repo: repo.to_string(),
            revision: revision.to_string(),
            files: manifest_files,
        },
    )?;
    cleanup_obsolete_files(spec, entry, &dir);
    Ok(())
}

/// 切换条目后的清理：只删"该模型其他条目声明过、且不属于目标条目"的文件；
/// 未声明的第三方文件一律不碰（避免误删用户手放的东西）
fn cleanup_obsolete_files(
    spec: &'static crate::tts::spec::ModelSpec,
    target: &crate::tts::spec::DownloadEntry,
    dir: &Path,
) {
    let keep: Vec<&str> = target.files.iter().map(|f| f.name).collect();
    let mut obsolete: Vec<&str> = Vec::new();
    for entry in spec.entries {
        for f in entry.files {
            if !keep.contains(&f.name) && !obsolete.contains(&f.name) {
                obsolete.push(f.name);
            }
        }
    }
    for name in obsolete {
        let path = dir.join(name);
        if !path.is_file() {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            log::info!("[download] 切换条目清理旧文件: {}", path.display());
        } else {
            log::warn!("[download] 旧文件删除失败（可能被引擎占用）: {}", path.display());
        }
    }
}

fn run_download(
    app: AppHandle,
    spec: &'static crate::tts::spec::ModelSpec,
    entry_id: String,
    cancel: Arc<AtomicBool>,
) {
    let name = spec.name.to_string();
    // 下载目标目录：E2E 模型用引擎目录名（与 TTS 引擎查找一致）
    let dest = resolve_download_dir(&get_model_root(), &name);
    let _ = app.emit(
        "sidecar://event",
        json!({ "status": "model_download_started", "model": name.clone() }),
    );
    emit_models_state(&app);
    let result: Result<PathBuf, String> = (|| {
        // 有条目的模型（HF 源）：按条目精确文件逐个下载 + 落账 manifest
        if !spec.entries.is_empty() {
            let entry = if entry_id.is_empty() {
                spec.default_entry()
            } else {
                spec.entry(&entry_id)
            }
            .ok_or_else(|| format!("unknown entry: {entry_id}"))?;
            download_entry_files(&app, spec, entry, cancel.clone())?;
            return Ok(dest);
        }
        // 无条目的模型：整包下载（GitHub release 资产）后解压
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        match spec.source {
            DownloadSource::GithubRelease(url) => {
                download_github_release(url, &dest, &name, &app, &cancel)
            }
            DownloadSource::HuggingFace { repo, .. } => Err(format!(
                "{}：HF 源必须声明精选条目（entries），当前为 {repo}",
                spec.name
            )),
        }
    })();
    ACTIVE.lock().remove(&name);
    match result {
        Ok(p) => {
            // 附加文件（描述符声明，如 ZipVoice 的 vocoder）：落模型根，已存在则跳过
            for extra in spec.extra_files {
                let extra_dest = crate::model_manager::get_model_root().join(extra.dest_rel);
                if extra_dest.exists() {
                    continue;
                }
                let url = match extra.source {
                    DownloadSource::GithubRelease(url) => url,
                    DownloadSource::HuggingFace { repo, .. } => {
                        eprintln!("[download] 附加文件暂不支持 HF 源: {repo}");
                        continue;
                    }
                };
                let _ = app.emit(
                    "sidecar://event",
                    json!({ "status": "model_download_progress", "model": name.clone(), "progress": 0u32 }),
                );
                match download_single_file(url, &extra_dest, &name, &app, &cancel) {
                    Ok(()) => eprintln!("[download] extra file downloaded: {}", extra_dest.display()),
                    Err(e) => eprintln!("[download] extra file download failed: {e}"),
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

/// 从 GitHub releases 下载归档并解压到目标目录
///
/// 归档落在 `<模型根>/.tmp/`（与模型目录分离）：解压成功后删除；解压失败保留，
/// 重跑时 `net` 见归档已存在即跳过下载、只重试解压；中断则留 `<arch>.part` 供续传。
fn download_github_release(
    url: &str,
    dest: &Path,
    model_name: &str,
    app: &AppHandle,
    cancel: &AtomicBool,
) -> Result<PathBuf, String> {
    let client = build_download_client()?;
    let tmp_dir = get_model_root().join(".tmp");
    let arch = tmp_dir.join(format!("{model_name}.{}", crate::net::url_suffix(url)));
    let on_progress = download_progress_emitter(app.clone(), model_name);
    crate::net::download(
        &client,
        &crate::net::Download {
            url,
            dest: &arch,
            on_progress: Some(&on_progress),
            cancel: Some(cancel),
            headers: &[],
        },
    )?;

    // 解压阶段：发"解压中"事件（进度无百分比，防 UI 停在 100% 像卡死）
    let _ = app.emit(
        "sidecar://event",
        json!({ "status": "model_download_extracting", "model": model_name }),
    );
    if let Err(e) = crate::inference::runtime_download::extract_archive(&arch, dest) {
        // 保留归档：重跑只重试解压，不重新下载
        return Err(e);
    }
    let _ = std::fs::remove_file(&arch);
    flatten_tarball_subdir(dest)?;
    Ok(dest.to_path_buf())
}

/// 下载单个文件（不解压，用于 vocoder 等附加文件）；带与其他模型下载一致的进度事件
fn download_single_file(
    url: &str,
    dest: &Path,
    model_name: &str,
    app: &AppHandle,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let client = build_download_client()?;
    let on_progress = download_progress_emitter(app.clone(), model_name);
    crate::net::download(
        &client,
        &crate::net::Download {
            url,
            dest,
            on_progress: Some(&on_progress),
            cancel: Some(cancel),
            headers: &[],
        },
    )?;
    Ok(())
}

/// 下载用 reqwest 客户端（同一超时与代理口径；代理经 env + CONFIG 单一来源）
fn build_download_client() -> Result<reqwest::blocking::Client, String> {
    let proxy = { CONFIG.read().proxy.clone() };
    let _env_guard = ENV_SCOPE_LOCK.lock();
    apply_proxy_env(&proxy);
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .build()
        .map_err(|e| format!("HTTP client build failed: {e}"))
}

/// 模型下载进度事件发射器（`downloaded/total` 与 backend 现约定一致）
fn download_progress_emitter(app: AppHandle, model_name: &str) -> impl Fn(u64, Option<u64>) {
    let model_name = model_name.to_string();
    move |downloaded: u64, total: Option<u64>| {
        let pct = match total {
            Some(t) if t > 0 => (downloaded as f64 / t as f64 * 100.0) as u32,
            _ => 0,
        };
        let _ = app.emit(
            "sidecar://event",
            json!({
                "status": "model_download_progress",
                "model": model_name.as_str(),
                "progress": pct,
                "downloaded": downloaded,
                "total": total.unwrap_or(0),
            }),
        );
    }
}

/// GitHub tarball 解压后通常多一层目录（`sherpa-onnx-xxx/model.onnx`）→ 移到 `dest` 根
fn flatten_tarball_subdir(dest: &Path) -> Result<(), String> {
    let entries: Vec<_> = std::fs::read_dir(dest)
        .map_err(|e| format!("read_dir: {e}"))?
        .filter_map(|e| e.ok())
        .collect();
    for entry in &entries {
        if !entry.path().is_dir() {
            continue;
        }
        let sub = entry.path();
        let has_onnx = std::fs::read_dir(&sub)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .any(|e| e.path().extension().map(|x| x == "onnx").unwrap_or(false))
            })
            .unwrap_or(false);
        if has_onnx {
            for f in std::fs::read_dir(&sub).map_err(|e| format!("read_dir sub: {e}"))? {
                let f = f.map_err(|e| e.to_string())?;
                let target = dest.join(f.file_name());
                std::fs::rename(f.path(), &target).map_err(|e| format!("move: {e}"))?;
            }
            let _ = std::fs::remove_dir(&sub);
            break;
        }
    }
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

/// 来源标签（从下载来源推导，不引入第二真源）：
/// `github.com/<owner>/<repo>` 或 `huggingface.co/<owner>/<repo>`。前端直接显示。
fn source_label(source: DownloadSource) -> String {
    match source {
        DownloadSource::GithubRelease(url) => url
            .trim_start_matches("https://")
            .split("/releases/")
            .next()
            .unwrap_or(url)
            .to_string(),
        DownloadSource::HuggingFace { repo, .. } => format!("huggingface.co/{repo}"),
    }
}

pub fn list_models_payload(kind: Option<&str>) -> Value {
    let root = get_model_root();
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
        // 精选条目：每条的安装状态（manifest 核大小）+ 当前安装条目标记
        let downloading_entry = ACTIVE
            .lock()
            .get(spec.name)
            .map(|(_, id)| id.clone());
        let entries_json: Vec<Value> = spec
            .entries
            .iter()
            .map(|e| {
                let state = if downloading_entry.as_deref() == Some(e.id) {
                    "downloading"
                } else if entry_installed(&dir, spec, e.id) {
                    "downloaded"
                } else {
                    "not_downloaded"
                };
                json!({
                    "id": e.id,
                    "label_zh": e.label_zh,
                    "label_en": e.label_en,
                    "size_gb": e.size_gb,
                    "default": e.default,
                    "state": state,
                })
            })
            .collect();
        let active_entry: Option<&str> = active_entry_of(spec).map(|e| e.id);
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
            "source": source_label(spec.source),
            "entries": entries_json,
            "active_entry": active_entry,
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
            if let Some(main_file) = main_model_file(spec, &dir) {
                obj["model_path"] = json!(main_file.display().to_string());
                // GGUF 模型额外附带 mmproj 路径
                if uses_mmproj(spec.framework) {
                    if let Some(mmproj) = mmproj_file(spec, &dir) {
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

    fn tmp_model_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("voxflow_mm_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("mkdir");
        d
    }

    fn gguf_spec() -> &'static crate::tts::spec::ModelSpec {
        crate::tts::spec::ModelSpec::find("Qwen3-ASR-0.6B").expect("模型存在")
    }

    /// manifest 往返 + 条目安装判定（大小不一致/文件缺失/未知条目都必须为 false）
    #[test]
    fn test_manifest_roundtrip_and_entry_installed() {
        let spec = gguf_spec();
        let dir = tmp_model_dir("manifest");
        let entry = spec.default_entry().expect("默认条目");
        let mut files = Vec::new();
        for f in entry.files {
            std::fs::write(dir.join(f.name), b"0123456789").expect("写入");
            files.push((f.name.to_string(), 10u64));
        }
        write_manifest(
            &dir,
            &Manifest {
                entry: entry.id.to_string(),
                repo: "ggml-org/Qwen3-ASR-0.6B-GGUF".into(),
                revision: "main".into(),
                files: files.clone(),
            },
        )
        .expect("写清单");

        let read = read_manifest(&dir).expect("读回");
        assert_eq!(read.entry, entry.id);
        assert_eq!(read.revision, "main");
        assert_eq!(read.files.len(), entry.files.len());
        assert!(entry_installed(&dir, spec, entry.id), "清单齐全应判定已安装");
        let other = spec
            .entries
            .iter()
            .find(|e| e.id != entry.id)
            .expect("该模型应有第二条目");
        assert!(!entry_installed(&dir, spec, other.id), "另一条目的独有文件缺失 → 未装");
        assert!(!entry_installed(&dir, spec, "__no_such_entry__"), "未知条目为 false");

        // 大小不符 → 视为未完整（能发现截断/上游改名导致的半成品）
        std::fs::write(dir.join(entry.files[0].name), b"short").expect("截断");
        assert!(!entry_installed(&dir, spec, entry.id), "大小不符必须判 false");

        // 文件缺失 → false
        std::fs::write(dir.join(entry.files[0].name), b"0123456789").expect("恢复");
        std::fs::remove_file(dir.join(entry.files[1].name)).expect("删除");
        assert!(!entry_installed(&dir, spec, entry.id), "缺文件必须判 false");
    }

    /// HF 直链拼装（子目录 / 空格 / 非 ASCII 需百分号编码）
    #[test]
    fn test_hf_file_url_encoding() {
        assert_eq!(
            hf_file_url("owner/repo", "main", "model.safetensors"),
            "https://huggingface.co/owner/repo/resolve/main/model.safetensors"
        );
        assert_eq!(
            hf_file_url("owner/repo", "abc123", "sub dir/权重.bin"),
            "https://huggingface.co/owner/repo/resolve/abc123/sub%20dir/%E6%9D%83%E9%87%8D.bin"
        );
    }

    /// token 只发 huggingface.co（绝不泄漏给 GitHub）
    #[test]
    fn test_hf_auth_header_host_scoped() {
        let hf = "https://huggingface.co/o/r/resolve/main/a.bin";
        let gh = "https://github.com/k2-fsa/sherpa-onnx/releases/download/x/a.tar.bz2";
        assert!(hf_auth_header(hf, "hf_abc").is_some());
        assert!(hf_auth_header(gh, "hf_abc").is_none(), "GH 请求不得携带 HF token");
        assert!(hf_auth_header(hf, "   ").is_none(), "空 token 不带头");
    }

    /// 切条目清理：只删"其他条目声明过"的文件，未声明的第三方文件绝不碰
    #[test]
    fn test_cleanup_obsolete_files_scope() {
        let spec = gguf_spec();
        let dir = tmp_model_dir("cleanup");
        let keep_entry = spec.default_entry().expect("默认条目");
        // 制造"另一个条目独有文件" + 用户手放文件
        let other = spec
            .entries
            .iter()
            .find(|e| e.id != keep_entry.id)
            .expect("该模型应有第二条目");
        let other_only: Vec<&str> = other
            .files
            .iter()
            .map(|f| f.name)
            .filter(|n| {
                keep_entry.file(crate::tts::spec::FileRole::Main) != Some(*n)
                    && keep_entry.file(crate::tts::spec::FileRole::Mmproj) != Some(*n)
            })
            .collect();
        assert!(!other_only.is_empty(), "该模型两条目应有独有文件");
        for f in keep_entry.files {
            std::fs::write(dir.join(f.name), b"x").expect("写目标条目文件");
        }
        for n in &other_only {
            std::fs::write(dir.join(n), b"x").expect("写他人文件");
        }
        let stray = dir.join("我的笔记.txt");
        std::fs::write(&stray, b"mine").expect("写用户文件");

        cleanup_obsolete_files(spec, keep_entry, &dir);

        assert!(dir.join(keep_entry.file(crate::tts::spec::FileRole::Main).unwrap()).is_file(), "目标条目主文件必须保留");
        for n in &other_only {
            assert!(!dir.join(n).exists(), "其他条目独有文件应被清理: {n}");
        }
        assert!(stray.is_file(), "未声明的第三方文件不得删除");
    }

    /// payload：有条目的模型下发 entries/active_entry，取值为契约枚举
    #[test]
    fn test_payload_carries_entries() {
        let payload = list_models_payload(Some("asr"));
        let models = payload["models"].as_array().expect("models 数组");
        let qwen = models
            .iter()
            .find(|m| m["name"] == "Qwen3-ASR-0.6B")
            .expect("应含 Qwen3-ASR-0.6B");
        let entries = qwen["entries"].as_array().expect("entries 数组");
        assert_eq!(entries.len(), 2, "GGUF 模型应有两条精选条目");
        assert_eq!(entries.iter().filter(|e| e["default"] == true).count(), 1, "恰有一条默认");
        for e in entries {
            let state = e["state"].as_str().unwrap_or("");
            assert!(
                matches!(state, "downloaded" | "not_downloaded" | "downloading"),
                "条目状态取值非法: {state}"
            );
            assert!(e["size_gb"].as_f64().unwrap_or(0.0) > 0.0);
            assert!(!e["label_zh"].as_str().unwrap_or("").is_empty());
        }
        // active_entry：null 或必须是本模型条目 id
        match qwen["active_entry"].as_str() {
            Some(id) => assert!(entries.iter().any(|e| e["id"] == id), "active_entry 必须是本模型条目"),
            None => assert!(qwen["active_entry"].is_null(), "无安装时为 null"),
        }
        // 无条目的模型：空数组 + null（前端据此走旧路径）
        let sherpa = models
            .iter()
            .find(|m| m["name"] == "SenseVoice-int8")
            .expect("应含 SenseVoice-int8");
        assert_eq!(sherpa["entries"].as_array().map(|a| a.len()), Some(0));
        assert!(sherpa["active_entry"].is_null());
    }

    /// 有条目模型的 active_entry 解析：manifest 缺失时退回默认条目
    #[test]
    fn test_active_entry_falls_back_to_default() {
        let spec = gguf_spec();
        // 环境中的 model_root 可能未安装该模型 → active_entry_of 仍应返回默认条目
        let e = active_entry_of(spec).expect("有条目的模型必须能解析出条目");
        assert!(spec.entry(e.id).is_some());
        assert_eq!(spec.entries.is_empty(), false);
    }


    /// 来源标签推导（纯函数；前端直接显示，故必须精确）
    #[test]
    fn test_source_label_derivation() {
        assert_eq!(
            source_label(DownloadSource::GithubRelease(
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2"
            )),
            "github.com/k2-fsa/sherpa-onnx"
        );
        assert_eq!(
            source_label(DownloadSource::HuggingFace {
                repo: "ggml-org/Qwen3-ASR-0.6B-GGUF",
                revision: "main",
            }),
            "huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF"
        );
    }

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
        assert_eq!(kokoro["source"], "github.com/k2-fsa/sherpa-onnx");
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
        assert_eq!(qwen["source"], "huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF");
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
