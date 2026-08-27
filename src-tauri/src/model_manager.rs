//! Rust 原生模型管理器 — 替代 Python sidecar 的模型下载/管理
//!
//! 对应技术重构文档 Phase 2-3：`huggingface_hub` → `hf-hub` crate
//! 事件协议与 Python 侧完全一致（`sidecar://event`），前端 ModelsPanel 无需改动。
//! - 代理：写入 HTTP(S)_PROXY + NO_PROXY=localhost,127.0.0.1，reqwest `system-proxy` 自动读取
//!   `ENV_SCOPE_LOCK` 保证「写入环境变量 + build_sync」原子化，避免多线程并发建 Client 时的竞态。
//! - 镜像：`HFClientBuilder::endpoint()` 显式设置；`HF_ENDPOINT` 环境变量兜底
//! - Token：`HFClient::builder().token()` 显式传入，否则 `HF_TOKEN` / token 文件自动检索

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

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub enum ModelFormat {
    Gguf,   // llama-cpp-2 推理
    Onnx,   // ort 推理
}

#[derive(Clone)]
pub struct ModelInfo {
    name: &'static str,
    kind: &'static str,    // "asr" | "tts"
    format: ModelFormat,   // Gguf | Onnx
    repo: &'static str,
    size_gb: f64,
    description_zh: &'static str,
    description_en: &'static str,
    available: bool,
    /// CPU 模式体验分级："good"（可用）/ "slow"（能跑但慢）/ "unsupported"（不支持 CPU）
    cpu: &'static str,
    /// GitHub releases 下载地址（优先使用，不需要 HF 认证）
    github_release: Option<&'static str>,
    /// 引擎使用的目录名（与展示名不同，如 "Matcha-zh-baker" → "matcha-icefall-zh-baker"）。
    /// 下载/查找/删除都用它，保证与 TTS 引擎一致。
    engine_dir: Option<&'static str>,
    /// 量化版本（GGUF: Q8_0 / bf16；ONNX: 无）——用于展示
    quant: Option<&'static str>,
}

impl ModelInfo {
    pub fn format(&self) -> &ModelFormat { &self.format }
    #[allow(dead_code)]
    pub fn kind(&self) -> &str { self.kind }
    #[allow(dead_code)]
    pub fn name(&self) -> &str { self.name }
}

static REGISTRY: &[ModelInfo] = &[
    // ── ASR：llama-cpp-2 (GGUF) ──
    ModelInfo {
        name: "Qwen3-ASR-0.6B",
        kind: "asr",
        format: ModelFormat::Gguf,
        repo: "ggml-org/Qwen3-ASR-0.6B-GGUF",
        size_gb: 0.95,
        description_zh: "默认识别模型 · GGUF 量化 · 更快 · 内存占用更低",
        description_en: "Default ASR model · GGUF quantized · faster · lower memory",
        available: true,
        cpu: "good",
        github_release: None,
        engine_dir: Some("qwen3-asr-0.6b-gguf"),
        quant: Some("Q8_0"),
    },
    ModelInfo {
        name: "Qwen3-ASR-1.7B",
        kind: "asr",
        format: ModelFormat::Gguf,
        repo: "ggml-org/Qwen3-ASR-1.7B-GGUF",
        size_gb: 2.35,
        description_zh: "更准 · GGUF 量化 · 需要更多内存/显存",
        description_en: "More accurate · GGUF quantized · needs more memory",
        available: true,
        cpu: "slow",
        github_release: None,
        engine_dir: None,
        quant: Some("Q8_0"),
    },
    // ── TTS：sherpa-onnx 纯端到端模型（子进程）──
    // 8 个模型均为 E2E（无音素 G2P 依赖），经 sherpa-onnx-offline-tts.exe 推理。
    // 下载源：GitHub releases（无需 HF 认证，速度快）
    ModelInfo {
        name: "Kokoro-v1_1",
        kind: "tts",
        format: ModelFormat::Onnx,
        repo: "k2-fsa/kokoro-multi-lang-v1_1",
        size_gb: 0.32,
        description_zh: "Kokoro 多语言 v1.1 · 中英103音色 · 纯端到端 · sherpa-onnx 推荐",
        description_en: "Kokoro multi-lang v1.1 · zh/en 103 voices · E2E · sherpa-onnx recommended",
        available: true,
        cpu: "good",
        github_release: Some("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2"),
        engine_dir: Some("kokoro-multi-lang-v1_1"),
        quant: None,
    },
    ModelInfo {
        name: "Kokoro-v1_0",
        kind: "tts",
        format: ModelFormat::Onnx,
        repo: "k2-fsa/kokoro-multi-lang-v1_0",
        size_gb: 0.32,
        description_zh: "Kokoro 多语言 v1.0 · 中英53音色 · 纯端到端",
        description_en: "Kokoro multi-lang v1.0 · zh/en 53 voices · E2E",
        available: true,
        cpu: "good",
        github_release: Some("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2"),
        engine_dir: Some("kokoro-multi-lang-v1_0"),
        quant: None,
    },
    ModelInfo {
        name: "Kokoro-en-v0_19",
        kind: "tts",
        format: ModelFormat::Onnx,
        repo: "k2-fsa/kokoro-en-v0_19",
        size_gb: 0.32,
        description_zh: "Kokoro 英文 v0.19 · 11音色 · 纯端到端",
        description_en: "Kokoro English v0.19 · 11 voices · E2E",
        available: true,
        cpu: "good",
        github_release: Some("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2"),
        engine_dir: Some("kokoro-en-v0_19"),
        quant: None,
    },
    ModelInfo {
        name: "Matcha-zh-baker",
        kind: "tts",
        format: ModelFormat::Onnx,
        repo: "k2-fsa/matcha-icefall-zh-baker",
        size_gb: 0.3,
        description_zh: "Matcha 中文 · 高质量 · 纯端到端",
        description_en: "Matcha Chinese · high quality · E2E",
        available: true,
        cpu: "good",
        github_release: Some("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/matcha-icefall-zh-baker.tar.bz2"),
        engine_dir: Some("matcha-icefall-zh-baker"),
        quant: None,
    },
    ModelInfo {
        name: "ZipVoice-distill",
        kind: "tts",
        format: ModelFormat::Onnx,
        repo: "k2-fsa/sherpa-onnx-zipvoice-distill",
        size_gb: 0.4,
        description_zh: "ZipVoice 蒸馏 · 中英 · 语音克隆 · 纯端到端",
        description_en: "ZipVoice distill · zh/en · voice clone · E2E",
        available: true,
        cpu: "good",
        github_release: Some("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2"),
        engine_dir: Some("sherpa-onnx-zipvoice-distill"),
        quant: None,
    },
    ModelInfo {
        name: "PocketTTS-int8",
        kind: "tts",
        format: ModelFormat::Onnx,
        repo: "k2-fsa/sherpa-onnx-pocket-tts-int8",
        size_gb: 0.5,
        description_zh: "Pocket TTS int8 · 快速低延迟 · 语音克隆 · 纯端到端",
        description_en: "Pocket TTS int8 · fast · voice clone · E2E",
        available: true,
        cpu: "good",
        github_release: Some("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2"),
        engine_dir: Some("sherpa-onnx-pocket-tts-int8"),
        quant: None,
    },
    ModelInfo {
        name: "Supertonic-3-int8",
        kind: "tts",
        format: ModelFormat::Onnx,
        repo: "k2-fsa/sherpa-onnx-supertonic-3-tts-int8",
        size_gb: 0.6,
        description_zh: "Supertonic 3 · 31语言 · 高质量 · 纯端到端",
        description_en: "Supertonic 3 · 31 languages · high quality · E2E",
        available: true,
        cpu: "good",
        github_release: Some("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2"),
        engine_dir: Some("sherpa-onnx-supertonic-3-tts-int8"),
        quant: None,
    },
    ModelInfo {
        name: "Kitten-nano-en",
        kind: "tts",
        format: ModelFormat::Onnx,
        repo: "k2-fsa/kitten-nano-en-v0_1-fp16",
        size_gb: 0.2,
        description_zh: "Kitten nano · 轻量快速 · 英文 · 纯端到端",
        description_en: "Kitten nano · lightweight · en · E2E",
        available: true,
        cpu: "good",
        github_release: Some("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_1-fp16.tar.bz2"),
        engine_dir: Some("kitten-nano-en-v0_1-fp16"),
        quant: None,
    },
    // ── ASR：sherpa-onnx 离线模型（低端设备/CPU）──
    // 下载源：GitHub releases（asr-models tag），Rust 直接下载 tar.bz2 解压
    ModelInfo {
        name: "SenseVoice-int8",
        kind: "asr",
        format: ModelFormat::Onnx,
        repo: "k2-fsa/sherpa-onnx",
        size_gb: 0.23,
        description_zh: "中文全能 · 中英日韩粤 5 语 · 情感/事件/时间戳",
        description_en: "All-round Chinese · zh/en/ja/ko/yue · emotion/event/timestamps",
        available: true,
        cpu: "good",
        github_release: Some("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2"),
        engine_dir: Some("sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"),
        quant: None,
    },
    ModelInfo {
        name: "Paraformer-zh-small",
        kind: "asr",
        format: ModelFormat::Onnx,
        repo: "k2-fsa/sherpa-onnx",
        size_gb: 0.1,
        description_zh: "中文超小 · 74MB · 低端 CPU 设备首选",
        description_en: "Tiny Chinese · 74MB · best for low-end CPU",
        available: true,
        cpu: "good",
        github_release: Some("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2"),
        engine_dir: Some("sherpa-onnx-paraformer-zh-small-2024-03-09"),
        quant: None,
    },
];

fn find_model(name: &str) -> Option<&'static ModelInfo> {
    REGISTRY.iter().find(|m| m.name == name)
}

/// 公共接口：按名称查找模型信息（供 lib.rs load_model 使用）
pub fn find_model_info(name: &str) -> Option<&'static ModelInfo> {
    find_model(name)
}

// ── 运行时配置 ──

struct RuntimeConfig {
    model_root: PathBuf,
    mirror: String,
    proxy: String,
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

pub fn set_model_root(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("model root is empty".into());
    }
    if !p.is_absolute() {
        return Err(format!("model root must be absolute: {}", p.display()));
    }
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    let mut cfg = CONFIG.write();
    cfg.model_root = p.clone();
    Ok(p)
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

pub fn get_model_root() -> PathBuf {
    CONFIG.read().model_root.clone()
}
pub fn get_mirror() -> String {
    CONFIG.read().mirror.clone()
}
pub fn get_proxy() -> String {
    CONFIG.read().proxy.clone()
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

/// 查找主模型文件（GGUF: *.gguf 排除 mmproj；ONNX: 优先非量化的标准 FP32 模型）
/// 策略：ONNX 优先返回 `model.onnx`/`model_fp16.onnx` 等标准模型，避开 `model_q*` 等 QDQ 量化模型
/// （`ort 2.0 + onnxruntime 1.28` 加载 Q8F16 QDQ 模型会 `STATUS_ACCESS_VIOLATION` 崩溃）。
pub fn find_main_model_file(dir: &Path, format: &ModelFormat) -> Option<PathBuf> {
    let exts = match format {
        ModelFormat::Gguf => vec![".gguf"],
        ModelFormat::Onnx => vec![".onnx"],
    };
    let files = find_model_files(dir, 0, &exts);
    match format {
        ModelFormat::Gguf => {
            // 排除 mmproj 文件，取最大的那个作为主模型
            files.into_iter()
                .filter(|f| !f.file_name().unwrap_or_default().to_string_lossy().to_lowercase().contains("mmproj"))
                .max_by_key(|f| f.metadata().map(|m| m.len()).unwrap_or(0))
        }
        ModelFormat::Onnx => {
            let is_qdq = |p: &PathBuf| {
                p.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase()
                    .contains("_q")
            };
            // 优先非量化的标准模型（model.onnx / model_fp16.onnx 等）
            if let Some(p) = files
                .iter()
                .filter(|p| !is_qdq(p))
                .max_by_key(|p| p.metadata().map(|m| m.len()).unwrap_or(0))
                .cloned()
            {
                return Some(p);
            }
            // 回退：只有量化模型时，取最大的（由 tts.rs 加载时根据需要选择）
            files.into_iter()
                .max_by_key(|f| f.metadata().map(|m| m.len()).unwrap_or(0))
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
    // 检测 2：递归查找模型文件
    let gguf_files = find_model_files(dir, 0, &[".gguf"]);
    if !gguf_files.is_empty() { return true; }
    let onnx_files = find_model_files(dir, 0, &[".onnx"]);
    if !onnx_files.is_empty() { return true; }
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
    let info = find_model(name)
        .ok_or_else(|| format!("unknown model: {name}"))?
        .clone();
    if !info.available {
        return Err(format!("engine not available yet: {}", info.name));
    }

    // 迁移旧布局：E2E 模型曾下载到展示名目录（如 models/Matcha-zh-baker），
    // 现在引擎找引擎目录名（matcha-icefall-zh-baker）。若旧目录已存在且完整，
    // 直接迁移到新目录名并返回“已就绪”，避免用户重新下载。
    let root = get_model_root();
    let new_dir = resolve_download_dir(&root, &info.name);
    let old_dir = root.join(&info.name);
    if old_dir != new_dir && old_dir.is_dir() && !new_dir.exists() {
        if is_complete(&old_dir) {
            if std::fs::rename(&old_dir, &new_dir).is_ok() {
                eprintln!("[model] migrated {} -> {}", old_dir.display(), new_dir.display());
                let _ = app.emit(
                    "sidecar://event",
                    json!({"status": "model_downloaded", "model": info.name, "path": new_dir.display().to_string()}),
                );
                emit_models_state(&app);
                return Ok(());
            }
        }
    }
    if let Some(free) = free_bytes_for_root() {
        let need = (info.size_gb * 1024f64.powi(3)) as u64;
        if free < need {
            return Err(format!(
                "disk full: need ~{}GB, free {:.1}GB",
                info.size_gb,
                free as f64 / 1024f64.powi(3)
            ));
        }
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = ACTIVE.lock();
        if active.contains_key(info.name) {
            return Ok(());
        }
        active.insert(info.name.to_string(), cancel.clone());
    }
    let app2 = app.clone();
    let name_owned = info.name.to_string();
    thread::Builder::new()
        .name(format!("dl-{name_owned}"))
        .spawn(move || run_download(app2, info, cancel))
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
    let _ = find_model(name).ok_or_else(|| format!("unknown model: {name}"))?;
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
    let (mirror, proxy, token) = {
        let cfg = CONFIG.read();
        let tok = std::env::var("HF_TOKEN").ok();
        (cfg.mirror.clone(), cfg.proxy.clone(), tok)
    };
    let _env_guard = ENV_SCOPE_LOCK.lock();
    apply_proxy_env(&proxy);
    apply_mirror_env(&mirror);
    let mut builder = hf_hub::HFClient::builder();
    if !mirror.trim().is_empty() {
        builder = builder.endpoint(mirror.trim());
    }
    if let Some(t) = token.as_deref().filter(|s| !s.trim().is_empty()) {
        builder = builder.token(t.trim());
    }
    builder.build_sync().map_err(|e| e.to_string())
}

fn run_download(app: AppHandle, info: ModelInfo, cancel: Arc<AtomicBool>) {
    let name = info.name.to_string();
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
        if let Some(url) = info.github_release {
            return download_github_release(url, &dest, &name, &app, &cancel);
        }
        // 回退到 HuggingFace
        let client = build_client_sync()?;
        let (owner, repo_name) = hf_hub::split_id(info.repo);
        let handler = IpcProgress::new(app.clone(), name.clone(), cancel.clone());
        let progress = hf_hub::progress::Progress::new(handler);
        // GGUF 模型只下载 Q8_0 量化版（模型 + mmproj），跳过 bf16 全精度与 safetensors 原始版
        // （bf16 单个 4G+，全量 snapshot 会白白下载 6G+；llama-server 只用 Q8_0）
        let allow_q8: Option<Vec<String>> = match info.format() {
            ModelFormat::Gguf => Some(vec!["*Q8_0.gguf".to_string()]),
            ModelFormat::Onnx => None,
        };
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
            if info.name == "ZipVoice-distill" {
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

fn format_str(f: &ModelFormat) -> &'static str {
    match f {
        ModelFormat::Gguf => "gguf",
        ModelFormat::Onnx => "onnx",
    }
}

/// 解析 sherpa-onnx E2E 模型的真实目录：展示名（如 "Kokoro-v1_0"）→ 引擎目录（"kokoro-multi-lang-v1_0"）
/// 若引擎目录存在则返回它，否则回退到展示名目录
#[allow(dead_code)] // 测试专用
fn resolve_sherpa_model_dir(root: &Path, name: &str, default: &Path) -> PathBuf {
    use crate::tts::engine::e2e_registry::E2eTtsModel;
    for m in E2eTtsModel::all() {
        // 归一化比较：Kokoro-v1_0 vs kokoro-v1_0
        let norm = |s: &str| s.to_lowercase().replace(['-', '_'], "");
        if norm(m.id()) == norm(name) || norm(m.default_model_dir()) == norm(name) {
            let engine_dir = root.join(m.default_model_dir());
            if engine_dir.exists() {
                return engine_dir;
            }
        }
    }
    default.to_path_buf()
}

/// 计算模型下载/查找的目标目录：优先用注册表的 engine_dir（E2E 模型显式指定，
/// 与 TTS 引擎查找一致），否则回退到展示名目录。修复「下载到展示名目录
/// 但引擎找引擎目录名」的不一致。
fn resolve_download_dir(root: &Path, name: &str) -> PathBuf {
    if let Some(info) = find_model(name) {
        if let Some(dir) = info.engine_dir {
            return root.join(dir);
        }
    }
    // 兼容：E2E 注册表 id / default_model_dir 直接匹配（如 "matcha"）
    use crate::tts::engine::e2e_registry::E2eTtsModel;
    for m in E2eTtsModel::all() {
        let norm = |s: &str| s.to_lowercase().replace(['-', '_'], "");
        if norm(m.id()) == norm(name) || norm(m.default_model_dir()) == norm(name) {
            return root.join(m.default_model_dir());
        }
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
    for m in REGISTRY {
        if let Some(k) = kind {
            if m.kind != k {
                continue;
            }
        }
        // sherpa-onnx E2E 模型的目录名与展示名不同（如 Kokoro-v1_0 → kokoro-multi-lang-v1_0）
        // 统一用引擎目录名判定（与下载/删除/TTS 引擎一致）
        let real_dir = resolve_download_dir(&root, m.name);
        let state = if is_downloading(m.name) {
            "downloading"
        } else if is_complete(&real_dir) {
            "downloaded"
        } else {
            "not_downloaded"
        };
        let dir = real_dir;
        // 兼容旧布局残留：引擎目录不存在但展示名目录存在（如下载失败留了 Kokoro-v1_1）
        let legacy_dir = root.join(m.name);
        let dir_exists = dir.is_dir() || (legacy_dir != dir && legacy_dir.is_dir());
        let mut obj = json!({
            "name": m.name,
            "kind": m.kind,
            "format": format_str(&m.format),
            "repo": m.repo,
            "size_gb": m.size_gb,
            "description_zh": m.description_zh,
            "description_en": m.description_en,
            "available": m.available,
            "cpu": m.cpu,
            "quant": m.quant,
            "path": dir.display().to_string(),
            "state": state,
            "dir_exists": dir_exists,
        });
        if state == "downloaded" {
            let bytes = dir_size_bytes(&dir);
            let gb = (bytes as f64 / 1024f64.powi(3) * 100.0).round() / 100.0;
            obj["size_on_disk_gb"] = json!(gb);
            // 附带主模型文件路径，方便前端直接加载
            if let Some(main_file) = find_main_model_file(&dir, &m.format) {
                obj["model_path"] = json!(main_file.display().to_string());
                // GGUF 模型额外附带 mmproj 路径
                if m.format == ModelFormat::Gguf {
                    if let Some(mmproj) = find_mmproj_file(&dir) {
                        obj["mmproj_path"] = json!(mmproj.display().to_string());
                    }
                }
            }
        }
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

// ── 框架选择器支持 ──

/// 获取指定 kind + format 的模型列表（供前端框架选择器过滤）
#[allow(dead_code)]
pub fn models_by_kind_and_format(kind: &str, format: &ModelFormat) -> Vec<&'static ModelInfo> {
    REGISTRY.iter()
        .filter(|m| m.kind == kind && m.format == *format && m.available)
        .collect()
}

/// 获取指定 kind 的所有可用格式（供前端框架选择器显示选项）
#[allow(dead_code)]
pub fn available_formats_for_kind(kind: &str) -> Vec<&'static str> {
    let mut formats = Vec::new();
    for m in REGISTRY {
        if m.kind == kind && m.available {
            let s = format_str(&m.format);
            if !formats.contains(&s) {
                formats.push(s);
            }
        }
    }
    formats
}

/// 格式字符串转 ModelFormat 枚举
#[allow(dead_code)]
pub fn parse_format(s: &str) -> Option<ModelFormat> {
    match s.to_lowercase().as_str() {
        "gguf" => Some(ModelFormat::Gguf),
        "onnx" => Some(ModelFormat::Onnx),
        _ => None,
    }
}

#[cfg(test)]
mod e2e_list_tests {
    use super::*;

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
