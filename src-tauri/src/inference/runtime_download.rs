//! 推理框架运行时（libs）下载与检测
//!
//! libs/ 是推理引擎二进制（llama-server / sherpa-onnx），与 exe 同级存放。
//! 首次启动/框架缺失时，从 GitHub release 下载压缩包 → 解压到 exe 旁 libs/。
//!
//! 下载统一走 `crate::net`（流式落盘 + 断点续传 + 重试 + 取消），代理经 env 单一来源。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::json;
use tauri::Emitter;

use crate::inference::runtime_paths;

/// 试启动就绪判定方式（数据驱动：新增框架只加一条数据行 + 一个变体值，不改函数）
pub enum SmokeProbe {
    /// 起进程后轮询 HTTP 健康端点，成功即就绪
    HttpHealth { path: &'static str },
    /// 无服务端点：等进程退出且 stderr 命中任一关键词（= exe+DLL 链完好）
    StderrKeywords { exit_and_stderr_contains_any: &'static [&'static str] },
    /// 启动 Python worker 的一次性 smoke test，stdout 必须返回成功 JSON。
    PythonWorker,
}
/// libs 压缩包发布信息（GitHub release 资产名 + 版本）
/// 更新引擎时改这里 + 发布新压缩包到 GitHub release。
pub struct RuntimePkg {
    /// 运行时包下载键（必须唯一；例如 pytorch-cpu / pytorch-cuda130）
    pub framework: &'static str,
    /// 引擎注册键（PyTorch 的 CPU/CUDA 包都映射到 pytorch）
    pub engine: &'static str,
    /// 展示名
    pub name: &'static str,
    /// 运行时变体（PyTorch 使用；既有框架为空字符串）
    pub variant: &'static str,
    /// 是否支持 CPU 推理
    pub supports_cpu: bool,
    /// 是否支持 CUDA 推理
    pub supports_cuda: bool,
    /// 版本（展示用；与 url / inner_dir 中的版本号人工保持一致，改动时三处同改）
    pub version: &'static str,
    /// 运行时包 SHA-256；空字符串表示未固定校验值
    pub sha256: &'static str,
    /// 附加包 SHA-256（aux_url 为空或未固定校验值时为空字符串）
    pub aux_sha256: &'static str,
    /// 解压后占用字节数（磁盘预检用；None = 按归档大小估算）
    pub unpacked_bytes: Option<u64>,
    /// 下载包中必须存在且可解析的 manifest 相对路径
    pub manifest: Option<&'static str>,
    /// GitHub release 资产 URL（下载地址）
    pub url: &'static str,
    /// 附加依赖包 URL（如 llama.cpp 官方把 CUDA 运行库拆成独立的 cudart-*.zip）
    pub aux_url: Option<&'static str>,
    /// aux 包内容解压到的目标子目录（相对 target_dir，"" = 根目录）。
    /// aux zip 应为扁平结构（内容直接放 aux_dir 下），无需任何包装/剥层逻辑。
    pub aux_dir: &'static str,
    /// 完整性校验文件（解压后必须存在，缺失 = 包不完整/需要修复）。
    /// 用于捕获"主程序在但运行库缺失"（如缺 cudart64_12.dll 导致 CUDA 静默回退 CPU）。
    pub aux_files: &'static [&'static str],
    /// 压缩包内顶层目录名（解压后要移出的子目录，如 "llama-cpp"）
    pub inner_dir: &'static str,
    /// 目标目录名（解压到 libs/ 下）
    pub target_dir: &'static str,
    /// 校验文件（存在即认为已安装）
    pub marker: &'static str,
    /// 试启动随机端口基线（避开默认端口与已运行实例）
    pub port_base: u16,
    /// 试启动参数（`$PORT` 占位符在运行时替换为实际端口）
    pub smoke_args: &'static [&'static str],
    /// 试启动就绪判定方式
    pub smoke_probe: SmokeProbe,
}

/// sherpa-onnx 自带的 CUDA 运行库资产（我们发布，固定版本）：
/// cudnn9×8 + cufft11×2 + cudart64_12/cublas64_12/cublasLt64_12 = 13 个 dll（打进 bin/）。
/// 官方 sherpa 包不含 NVIDIA 库，缺失会导致 CUDA EP 静默失败 → 必须随 sherpa 一起装。
/// 托管位置：本仓库 GitHub release 专用 tag `runtime-assets`（与版本号 release 分开）。
/// 更新资产时重跑 scripts/make-sherpa-cuda-runtime.ps1 并在该 release 替换文件。
pub const SHERPA_CUDA_AUX_URL: &str =
    "https://github.com/RebootFlume/voxflow/releases/download/runtime-assets/voxflow-sherpa-cuda12-runtime.zip";

/// sherpa CUDA EP 运行所需的 NVIDIA 运行库（13 个，相对 libs/sherpa-onnx/ 根的路径，
/// 实际位于 bin/ 下与 exe 同目录）。配套资产 zip 为扁平 13 个 dll（zip 根无目录），
/// 下载后经 aux_dir="bin" 声明整体落 sherpa-onnx/bin/。
/// 官方 sherpa 包不含 NVIDIA 库，缺失会导致 CUDA EP 静默失败。
pub const SHERPA_CUDA_AUX_FILES: &[&str] = &[
    "bin/cudart64_12.dll",
    "bin/cublas64_12.dll",
    "bin/cublasLt64_12.dll",
    "bin/cudnn64_9.dll",
    "bin/cudnn_adv64_9.dll",
    "bin/cudnn_cnn64_9.dll",
    "bin/cudnn_engines_precompiled64_9.dll",
    "bin/cudnn_engines_runtime_compiled64_9.dll",
    "bin/cudnn_graph64_9.dll",
    "bin/cudnn_heuristic64_9.dll",
    "bin/cudnn_ops64_9.dll",
    "bin/cufft64_11.dll",
    "bin/cufftw64_11.dll",
    // TTS 工具也必须在（与 ASR 的 websocket server 同层 bin/）：
    // 只校验 ASR exe 会让"缺 TTS exe"的包显示为已安装，TTS 首次合成才失败。
    "bin/sherpa-onnx-offline-tts.exe",
];

/// PyTorch CUDA 13.0 运行库辅包内容（29 个 DLL，解压到 pytorch-cuda130/Lib/site-packages/torch/lib/）。
///
/// 为什么整包成片而不是按功能再拆：torch 在 `torch/__init__.py::_load_dll_libraries()`
/// 里会预加载 `torch/lib` 下全部 DLL，实测缺任何一组（cudnn / cublas / cusolver / cufft /
/// nvrtc）都会让 `import torch` 直接抛 `WinError 126` —— 辅包必须与主包一起安装，
/// 不能按需跳过；因此拆分的意义只是绕开 GitHub 单资产 2 GiB 上限与细化重试粒度。
///
/// 托管位置：本仓库 GitHub release 专用 tag `runtime-assets`。
/// 更新资产时重跑 scripts/build-pytorch-runtime.ps1 -Variant cuda130。
pub const CUDA130_AUX_FILES: &[&str] = &[
    "Lib/site-packages/torch/lib/c10_cuda.dll",
    "Lib/site-packages/torch/lib/caffe2_nvrtc.dll",
    "Lib/site-packages/torch/lib/cublas64_13.dll",
    "Lib/site-packages/torch/lib/cublasLt64_13.dll",
    "Lib/site-packages/torch/lib/cudart64_13.dll",
    "Lib/site-packages/torch/lib/cudnn64_9.dll",
    "Lib/site-packages/torch/lib/cudnn_adv64_9.dll",
    "Lib/site-packages/torch/lib/cudnn_cnn64_9.dll",
    "Lib/site-packages/torch/lib/cudnn_engines_precompiled64_9.dll",
    "Lib/site-packages/torch/lib/cudnn_engines_runtime_compiled64_9.dll",
    "Lib/site-packages/torch/lib/cudnn_engines_tensor_ir64_9.dll",
    "Lib/site-packages/torch/lib/cudnn_ext64_9.dll",
    "Lib/site-packages/torch/lib/cudnn_graph64_9.dll",
    "Lib/site-packages/torch/lib/cudnn_heuristic64_9.dll",
    "Lib/site-packages/torch/lib/cudnn_ops64_9.dll",
    "Lib/site-packages/torch/lib/cufft64_12.dll",
    "Lib/site-packages/torch/lib/cufftw64_12.dll",
    "Lib/site-packages/torch/lib/cupti64_2025.3.0.dll",
    "Lib/site-packages/torch/lib/curand64_10.dll",
    "Lib/site-packages/torch/lib/cusolver64_12.dll",
    "Lib/site-packages/torch/lib/cusolverMg64_12.dll",
    "Lib/site-packages/torch/lib/cusparse64_12.dll",
    "Lib/site-packages/torch/lib/nvJitLink_130_0.dll",
    "Lib/site-packages/torch/lib/nvToolsExt64_1.dll",
    "Lib/site-packages/torch/lib/nvperf_host.dll",
    "Lib/site-packages/torch/lib/nvrtc-builtins64_130.dll",
    "Lib/site-packages/torch/lib/nvrtc64_130_0.alt.dll",
    "Lib/site-packages/torch/lib/nvrtc64_130_0.dll",
    "Lib/site-packages/torch/lib/torch_cuda.dll",
];

/// 当前发布包（官方版本，固定版本号）
/// - llama.cpp: b10622（cuda-12.4，与 benchmarks/setup.ps1 一致）
///   注意：官方 cuda 版拆成两个 zip —— 主程序包 + cudart 运行库包（cudart64/cublas）。
///   必须两个都下载，否则 CUDA 后端加载失败会【静默回退 CPU】。
/// - sherpa-onnx: v1.13.6（cuda-12.x-cudnn-9.x）
///   官方包只含 exe + onnxruntime，NVIDIA 运行库(cudnn/cufft/cudart/cublas)另行随装 → 自包含。
pub const RUNTIME_PACKAGES: &[RuntimePkg] = &[
    RuntimePkg {
        framework: "gguf",
        engine: "gguf",
        variant: "",
        supports_cpu: true,
        supports_cuda: true,
        name: "llama-server",
        version: "b10622",
        sha256: "",
        aux_sha256: "",
        unpacked_bytes: None,
        manifest: None,
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b10622/llama-b10622-bin-win-cuda-12.4-x64.zip",
        aux_url: Some("https://github.com/ggml-org/llama.cpp/releases/download/b10622/cudart-llama-bin-win-cuda-12.4-x64.zip"),
        aux_dir: "",
        aux_files: &["cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll"],
        inner_dir: "llama-b10622-bin-win-cuda-12.4-x64",
        target_dir: "llama-cpp",
        marker: "llama-server.exe",
        port_base: 0,
        smoke_args: &["--port", "$PORT", "--no-webui"],
        smoke_probe: SmokeProbe::HttpHealth { path: "/health" },
    },
    RuntimePkg {
        framework: "onnx",
        engine: "onnx",
        variant: "",
        supports_cpu: true,
        supports_cuda: true,
        name: "sherpa-onnx",
        version: "v1.13.6",
        sha256: "",
        aux_sha256: "",
        unpacked_bytes: None,
        manifest: None,
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.6/sherpa-onnx-v1.13.6-cuda-12.x-cudnn-9.x-onnxruntime1.27.1-win-x64-cuda.tar.bz2",
        aux_url: Some(SHERPA_CUDA_AUX_URL),
        aux_dir: "bin",
        aux_files: SHERPA_CUDA_AUX_FILES,
        inner_dir: "sherpa-onnx-v1.13.6-cuda-12.x-cudnn-9.x-onnxruntime1.27.1-win-x64-cuda",
        target_dir: "sherpa-onnx",
        marker: "bin/sherpa-onnx-offline-websocket-server.exe",
        port_base: 50,
        smoke_args: &["--port", "$PORT"],
        smoke_probe: SmokeProbe::StderrKeywords {
            exit_and_stderr_contains_any: &[
                "does not exist", "recognizer config", "Invalid integer option",
                "tokens:", "ParseOptions", "parse-options",
            ],
        },
    },
    RuntimePkg {
        framework: "pytorch-cpu",
        engine: "pytorch",
        variant: "cpu",
        supports_cpu: true,
        supports_cuda: false,
        name: "PyTorch",
        version: "2.14.0-py311-cpu",
        sha256: "07d82e345023e838ad3a052ac33ac6e7954ea892c982f31e16c1dae2bf2685e7",
        aux_sha256: "",
        unpacked_bytes: Some(808768572),
        manifest: Some("runtime-manifest.json"),
        url: "https://github.com/RebootFlume/voxflow/releases/download/runtime-assets/voxflow-pytorch-cpu-py311-torch2.14.0-win-x64.zip",
        aux_url: None,
        aux_dir: "",
        aux_files: &["worker.py", "runtime-manifest.json", "Lib/site-packages/torch/__init__.py"],
        inner_dir: "",
        target_dir: "pytorch-cpu",
        marker: "python.exe",
        port_base: 0,
        smoke_args: &["worker.py", "--smoke-test"],
        smoke_probe: SmokeProbe::PythonWorker,
    },
    RuntimePkg {
        framework: "pytorch-cuda130",
        engine: "pytorch",
        variant: "cuda130",
        supports_cpu: true,
        supports_cuda: true,
        name: "PyTorch",
        version: "2.14.0-py311-cuda130",
        sha256: "d1c50052830fe2b596377b5644d6093a282b0ae910662ea30479a802d2dbf545",
        aux_sha256: "42d42881e826b160e858899c2ce38d820f4db573524098088af29da9b2e71f91",
        unpacked_bytes: Some(3352022021),
        manifest: Some("runtime-manifest.json"),
        url: "https://github.com/RebootFlume/voxflow/releases/download/runtime-assets/voxflow-pytorch-cuda130-py311-torch2.14.0-win-x64.zip",
        // CUDA 运行库单独成包：torch 在 import 时会预加载 torch/lib 下全部 DLL，
        // 缺任何一个被引用的都会让 import torch 失败 → 辅包必须与主包一起装、不能按需跳过。
        aux_url: Some("https://github.com/RebootFlume/voxflow/releases/download/runtime-assets/voxflow-pytorch-cuda130-cuda13-libs.zip"),
        aux_dir: "Lib/site-packages/torch/lib",
        aux_files: CUDA130_AUX_FILES,
        inner_dir: "",
        target_dir: "pytorch-cuda130",
        marker: "python.exe",
        port_base: 0,
        smoke_args: &["worker.py", "--smoke-test"],
        smoke_probe: SmokeProbe::PythonWorker,
    },
];

/// libs 根目录（exe 旁 libs/，便携与安装共用）
pub fn libs_root() -> PathBuf {
    runtime_paths::libs_dir()
}

/// 某个框架的 libs 目录
fn pkg_dir(pkg: &RuntimePkg) -> PathBuf {
    libs_root().join(pkg.target_dir)
}

/// 检测框架是否已安装（与推理启动共用同一路径解析：能找到启动 exe = 已下载）
/// 同时校验 aux_files（如 CUDA 运行库）完整 —— 主程序在但运行库缺失 = 未完成安装，
/// 前端据此显示"需要修复/重新下载"（否则 CUDA 会静默回退 CPU）。
pub fn is_runtime_installed(pkg: &RuntimePkg) -> bool {
    let dir = runtime_dir_for(pkg);
    if !dir.join(pkg.marker).exists() {
        return false;
    }
    if let Some(manifest) = pkg.manifest {
        if !runtime_manifest_matches(pkg, &dir.join(manifest)) {
            return false;
        }
    }
    pkg.aux_files.iter().all(|f| dir.join(f).exists())
}

fn runtime_manifest_matches(pkg: &RuntimePkg, path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else { return false };
    // 构建工具（Windows PowerShell 5.1）会写 UTF-8 BOM，serde_json 不接受 → 先剥掉
    let raw = raw.trim_start_matches('\u{feff}');
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else { return false };
    value.get("worker_protocol").and_then(|v| v.as_u64()) == Some(1)
        && value.get("variant").and_then(|v| v.as_str()) == Some(pkg.variant)
        && value.get("torch").and_then(|v| v.as_str()).is_some_and(|v| v.starts_with("2.14.0"))
        && value.get("script").and_then(|v| v.as_str()) == Some("worker.py")
}
/// missing=主程序都未下载。
pub fn runtime_diagnose(pkg: &RuntimePkg) -> (String, Vec<String>) {
    let d = runtime_dir_for(pkg);
    let marker = d.join(pkg.marker);
    if !marker.exists() {
        return ("missing".into(), vec![pkg.marker.to_string()]);
    }
    let mut missing: Vec<String> = pkg
        .aux_files
        .iter()
        .filter(|f| !d.join(f).exists())
        .map(|f| f.to_string())
        .collect();
    if let Some(manifest) = pkg.manifest {
        if !runtime_manifest_matches(pkg, &d.join(manifest)) {
            missing.push(manifest.to_string());
        }
    }
    if missing.is_empty() { ("ready".into(), Vec::new()) } else { ("incomplete".into(), missing) }
}

/// 检测所有框架状态，返回 JSON（供前端展示）——三态：ready / incomplete / missing
pub fn runtime_status() -> serde_json::Value {
    let items: Vec<serde_json::Value> = RUNTIME_PACKAGES
        .iter()
        .map(|p| {
            let (state, missing) = runtime_diagnose(p);
            json!({
                "framework": p.framework,
                "engine": p.engine,
                "name": p.name,
                "variant": p.variant,
                "supports_cpu": p.supports_cpu,
                "supports_cuda": p.supports_cuda,
                "version": p.version,
                "installed": state == "ready",
                "state": state,
                "missing": missing,
                "dir": runtime_dir_for(p).display().to_string(),
            })
        })
        .collect();
    json!({
        "status": "runtime_status",
        "root": libs_root().display().to_string(),
        "packages": items,
    })
}

/// 选择已安装且支持目标设备的运行时包。
/// CPU 请求优先复用 CUDA 版 PyTorch；CUDA wheel 同时包含 CPU kernel。
pub fn installed_runtime_for_device(engine: &str, device: &str) -> Option<&'static RuntimePkg> {
    let wants_cuda = matches!(device.trim().to_ascii_lowercase().as_str(), "cuda" | "gpu");
    RUNTIME_PACKAGES
        .iter()
        .filter(|p| p.engine == engine)
        .filter(|p| if wants_cuda { p.supports_cuda } else { p.supports_cpu })
        .filter(|p| is_runtime_installed(p))
        .min_by_key(|p| if !wants_cuda && p.variant == "cuda130" { 0 } else { 1 })
}

/// 返回适合目标设备的默认下载包。已安装包优先，避免切换设备时重复下载。
pub fn preferred_runtime_for_device(engine: &str, device: &str) -> Option<&'static RuntimePkg> {
    installed_runtime_for_device(engine, device).or_else(|| {
        let wants_cuda = matches!(device.trim().to_ascii_lowercase().as_str(), "cuda" | "gpu");
        RUNTIME_PACKAGES.iter().find(|p| {
            p.engine == engine
                && if wants_cuda { p.supports_cuda } else { p.variant == "cpu" && p.supports_cpu }
        })
    })
}

/// 单框架诊断 JSON（纯文件检查，不触发下载/启动）——供框架页初始三态显示
pub fn runtime_diagnose_json(framework: &str) -> serde_json::Value {
    let empty = json!({ "state": "missing", "missing": [], "dir": "" });
    match RUNTIME_PACKAGES.iter().find(|p| p.framework == framework) {
        Some(p) => {
            let (state, missing) = runtime_diagnose(p);
            json!({
                "state": state,
                "installed": state == "ready",
                "missing": missing,
                "dir": runtime_dir_for(p).display().to_string(),
            })
        }
        None => empty,
    }
}

/// 两步验证（供「验证」按钮与下载完成共用）：
///   ① 文件检查：marker + aux_files 缺一 → incomplete + 缺失清单
///   ② 试启动：DLL 链能否真跑（llama /health；sherpa 无模型走到"缺模型"错误 = 链好）
/// 都过 = ready；② 失败 = error + 原因。
pub fn verify_runtime_full(framework: &str) -> serde_json::Value {
    let empty = json!({ "state": "missing", "missing": [], "error": "" });
    let Some(pkg) = RUNTIME_PACKAGES.iter().find(|p| p.framework == framework) else {
        return empty;
    };
    // ① 文件检查
    let (state, missing) = runtime_diagnose(pkg);
    if state != "ready" {
        return json!({
            "state": state,
            "installed": false,
            "missing": missing,
            "error": "",
            "dir": runtime_dir_for(pkg).display().to_string(),
        });
    }
    // ② 试启动
    match smoke_test_runtime(pkg) {
        Ok(()) => json!({
            "state": "ready",
            "installed": true,
            "missing": [],
            "error": "",
            "dir": runtime_dir_for(pkg).display().to_string(),
        }),
        Err(e) => json!({
            "state": "error",
            "installed": false,
            "missing": [],
            "error": e,
            "dir": runtime_dir_for(pkg).display().to_string(),
        }),
    }
}

/// 框架 → 运行时目录（单一真源：RUNTIME_PACKAGES 的 target_dir）。
/// 新增框架只加数据行；未收录的框架返回 None，由调用方决定回退。
fn dir_for_framework(framework: &str) -> Option<PathBuf> {
    RUNTIME_PACKAGES
        .iter()
        .find(|p| p.framework == framework)
        .map(|p| libs_root().join(p.target_dir))
}

/// 某框架的运行时目录（与推理启动同一路径解析）
pub fn runtime_dir_for(pkg: &RuntimePkg) -> PathBuf {
    // 未收录 → 与旧行为一致的兜底（libs 根）
    dir_for_framework(pkg.framework).unwrap_or_else(libs_root)
}

/// 下载单文件，进度映射到全局区间 [span_start, span_end]（主包+附件合并成一条 0→100，
/// 避免"每文件独立跑 0→100"导致进度条反复回跳）。span 两端为全局总进度（0..=100）。
/// 取远程文件大小（HEAD / GET headers），用于总进度权重分配
fn http_size(client: &reqwest::blocking::Client, url: &str, label: &str) -> Result<u64, String> {
    let resp = client
        .head(url)
        .send()
        .map_err(|e| format!("HTTP HEAD failed ({label}): {e}"))?;
    if !resp.status().is_success() {
        // 部分服务器不支持 HEAD → 退化为 GET 读 header
        let resp = client
            .get(url)
            .send()
            .map_err(|e| format!("HTTP GET failed ({label}): {e}"))?;
        return Ok(resp.content_length().unwrap_or(0));
    }
    Ok(resp.content_length().unwrap_or(0))
}

/// 下载中的框架（framework → 取消标志）；同一框架同时只允许一个下载
static ACTIVE_RUNTIME: once_cell::sync::Lazy<parking_lot::Mutex<HashMap<String, Arc<AtomicBool>>>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(HashMap::new()));

/// 请求取消某框架的进行中下载（仅下载阶段可中断；解压阶段不可中断）
pub fn request_cancel_runtime(framework: &str) -> bool {
    if let Some(flag) = ACTIVE_RUNTIME.lock().get(framework) {
        flag.store(true, Ordering::SeqCst);
        return true;
    }
    false
}

/// 注册句柄：任意返回路径（含 `?` 提前返回）都会摘除注册，防"卡在下载中"的假状态
struct ActiveGuard(&'static str);

impl ActiveGuard {
    fn register(framework: &'static str, flag: Arc<AtomicBool>) -> Result<Self, String> {
        let mut active = ACTIVE_RUNTIME.lock();
        if active.contains_key(framework) {
            return Err(format!("{framework} 已在下载中"));
        }
        active.insert(framework.to_string(), flag);
        Ok(Self(framework))
    }
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        ACTIVE_RUNTIME.lock().remove(self.0);
    }
}

/// 下载一个包到 `out`，进度映射到 `[span_start, span_end]`（多包合并为一条 0→100）
///
/// 传输交给 `crate::net`（流式 + 断点续传 + 重试 + 取消），本函数只做区间映射。
#[allow(clippy::too_many_arguments)]
fn download_to_file(
    client: &reqwest::blocking::Client,
    app: &tauri::AppHandle,
    url: &str,
    framework: &str,
    label: &str,
    out: &std::path::Path,
    span_start: u32,
    span_end: u32,
    cancel: &AtomicBool,
) -> Result<(), String> {
    log::info!(
        "[framework] 下载{label}: {}",
        url.rsplit('/').next().unwrap_or(url)
    );
    let on_progress = |downloaded: u64, total: Option<u64>| {
        let pct = match total {
            Some(t) if t > 0 => {
                let f = downloaded as f64 / t as f64;
                span_start + ((span_end.saturating_sub(span_start)) as f64 * f) as u32
            }
            // 大小未知：停在区间起点（只更新字节数）；完成时 net 补 (n, Some(n)) → 落到 span_end
            _ => span_start,
        };
        let _ = app.emit(
            "sidecar://event",
            json!({
                "status": "runtime_download_progress",
                "framework": framework,
                "progress": pct,
                "downloaded": downloaded,
                "total": total.unwrap_or(0),
            }),
        );
    };
    crate::net::download(
        client,
        &crate::net::Download {
            url,
            dest: out,
            on_progress: Some(&on_progress),
            cancel: Some(cancel),
            headers: &[],
        },
    )?;
    Ok(())
}

fn verify_archive_sha256(path: &Path, expected: &str) -> Result<(), String> {
    if expected.is_empty() { return Ok(()); }
    let mut file = std::fs::File::open(path).map_err(|e| format!("open archive for hash: {e}"))?;
    use std::io::Read;
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    let mut buf = [0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("read archive for hash: {e}"))?;
        if n == 0 { break; }
        digest.update(&buf[..n]);
    }
    let actual = format!("{:x}", digest.finalize());
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!("SHA-256 校验失败：期望 {expected}，实际 {actual}"))
    }
}

/// 下载 + 解压一个框架到 libs/（带进度事件，可取消）
///
/// 逻辑（与主包/附件一视同仁，没有特殊处理）：
///   1. 下载：主包、附件各用同一 download_to_file
///   2. 解压：两者各用同一 extract_archive，解到独立临时目录
///   3. 落位：place_extracted —— 解压结果若只有一层 wrapper 目录则剥掉，
///      内容放进目标目录。主包 → target 根；附件 → target/aux_dir（"" = 根）
///   4. 完整性校验（marker + aux_files）+ 试启动
pub fn download_runtime(app: &tauri::AppHandle, framework: &str) -> Result<(), String> {
    let pkg = RUNTIME_PACKAGES
        .iter()
        .find(|p| p.framework == framework)
        .ok_or_else(|| format!("unknown framework: {framework}"))?;

    if is_runtime_installed(pkg) {
        return Ok(()); // 已安装（含 aux 运行库校验）
    }

    // 取消注册（任意返回路径自动摘除）；同一框架同时只允许一个下载
    let cancel = Arc::new(AtomicBool::new(false));
    let _active = ActiveGuard::register(pkg.framework, cancel.clone())?;

    // 目标目录 = runtime_dir_for(pkg)（与完整性校验同一解析：llama/sherpa 都按 exe 旁 libs）
    let dest = runtime_dir_for(pkg);
    let root = dest.parent().map(|p| p.to_path_buf()).unwrap_or_else(libs_root);
    std::fs::create_dir_all(&root).map_err(|e| format!("create libs dir: {e}"))?;
    // 临时目录（dest 同级，同卷 rename 原子）
    let tmp = dest.with_file_name(format!("_runtime_{}", pkg.framework));
    if tmp.exists() {
        std::fs::remove_dir_all(&tmp).ok();
    }
    std::fs::create_dir_all(&tmp).map_err(|e| format!("create tmp: {e}"))?;

    // 1. 客户端（超时 + 显式代理）：与模型下载共用同一实现（仅写 env 对 reqwest 无效）
    let client = crate::model_manager::build_net_client(3600)?;

    log::info!("[framework] 开始下载 {} 运行时（主包 + 附件）", pkg.name);

    // 2. 下载：主包 + 附件（同一函数），进度合并为一条 0→100
    //    先 HEAD 拿两文件大小算权重，避免"每文件独立 0→100"进度条反复回跳
    let main_arch = tmp.join(format!("main.{}", crate::net::url_suffix(pkg.url)));
    let aux_arch = pkg
        .aux_url
        .map(|aux| tmp.join(format!("aux.{}", crate::net::url_suffix(aux))));
    // 大小只用于进度权重：HEAD 失败不阻断下载（退化为"主包独占 0..100"）
    let main_size = http_size(&client, pkg.url, "主程序").ok();
    let aux_size = pkg
        .aux_url
        .and_then(|u| http_size(&client, u, "附加运行库").ok());
    let merged = main_size.is_some() && (pkg.aux_url.is_none() || aux_size.is_some());
    if !merged {
        log::warn!("[framework] {} 大小探测失败：进度条按主包单包区间显示", pkg.name);
    }
    let total = main_size.unwrap_or(0) + aux_size.unwrap_or(0);
    // 主包占 [0, main_end]，附件占 [main_end, 100]
    let main_end = if merged && total > 0 {
        (main_size.unwrap_or(0) as f64 / total as f64 * 100.0) as u32
    } else {
        100
    };

    // 磁盘预检：归档与解压产物在解压期间并存 = 下载量 + 解压量
    // （解压量从数据表读取；未声明时按"与归档同量级"估算）
    let downloaded = main_size.unwrap_or(0) + aux_size.unwrap_or(0);
    let need = downloaded + pkg.unpacked_bytes.unwrap_or(downloaded);
    if need > 0 {
        if let Some(free) = crate::model_manager::free_bytes_for_dir(&root) {
            if free < need {
                let _ = std::fs::remove_dir_all(&tmp);
                return Err(format!(
                    "磁盘空间不足：需要约 {:.1}GB，剩余 {:.1}GB",
                    need as f64 / 1024f64.powi(3),
                    free as f64 / 1024f64.powi(3)
                ));
            }
        }
    }
    download_to_file(&client, app, pkg.url, pkg.framework, "主包", &main_arch, 0, main_end, &cancel)?;
    verify_archive_sha256(&main_arch, pkg.sha256)?;
    if let Some(path) = &aux_arch {
        let (s, e) = if merged { (main_end, 100) } else { (100, 100) };
        download_to_file(&client, app, pkg.aux_url.unwrap(), pkg.framework, "附加运行库", path, s, e, &cancel)?;
        verify_archive_sha256(path, pkg.aux_sha256)?;
    }

    // 3. 解压（主包/附件独立目录；解压无进度，发"解压中"状态防 UI 假卡死）
    let emit_phase = |phase: &str| {
        let _ = app.emit(
            "sidecar://event",
            json!({ "status": "runtime_download_phase", "framework": framework, "phase": phase }),
        );
    };
    emit_phase("extracting");
    log::info!("[framework] 下载完成，开始解压 {}（大包需 1-2 分钟）", pkg.name);
    let main_x = tmp.join("main_x");
    std::fs::create_dir_all(&main_x).map_err(|e| format!("create main_x: {e}"))?;
    log::info!("[framework] 解压主程序包...");
    extract_archive(&main_arch, &main_x).map_err(|e| format!("解压主程序失败: {e}"))?;
    let _ = std::fs::remove_file(&main_arch);

    let aux_x = aux_arch.as_ref().map(|_| tmp.join("aux_x"));
    if let Some(dir) = &aux_x {
        std::fs::create_dir_all(dir).map_err(|e| format!("create aux_x: {e}"))?;
        log::info!("[framework] 解压附加运行库包...");
        extract_archive(aux_arch.as_ref().unwrap(), dir).map_err(|e| format!("解压附加运行库失败: {e}"))?;
        let _ = std::fs::remove_file(aux_arch.as_ref().unwrap());
    }

    // 4. 落位：清空目标，主包内容 → dest；附件内容 → dest/aux_dir
    log::info!("[framework] 文件落位到 {}", dest.display());
    if dest.exists() {
        std::fs::remove_dir_all(&dest).ok();
    }
    std::fs::create_dir_all(&dest).map_err(|e| format!("create target dir: {e}"))?;
    place_extracted(&main_x, &dest)?;
    if let Some(dir) = &aux_x {
        let aux_target = if pkg.aux_dir.is_empty() {
            dest.clone()
        } else {
            dest.join(pkg.aux_dir)
        };
        std::fs::create_dir_all(&aux_target).map_err(|e| format!("create aux target: {e}"))?;
        place_extracted(dir, &aux_target)?;
    }
    let _ = std::fs::remove_dir_all(&tmp);

    // 5. 完整性校验：marker + aux_files 全部存在
    if !is_runtime_installed(pkg) {
        let missing: Vec<String> = std::iter::once(pkg.marker)
            .chain(pkg.aux_files.iter().copied())
            .filter(|f| !runtime_dir_for(pkg).join(f).exists())
            .map(|f| f.to_string())
            .collect();
        return Err(format!(
            "解压后完整性校验失败，缺失文件: {}（包可能不完整，或官方资产结构变化）",
            missing.join(", ")
        ));
    }

    // 6. 试启动验证（marker 存在 ≠ 能跑；缺 DLL 时 spawn 即失败/秒退）
    log::info!("[framework] 完整性校验通过，试启动引擎验证 DLL 链...");
    smoke_test_runtime(pkg).map_err(|e| format!("试启动验证失败（可能 DLL 缺失）：{e}"))?;
    log::info!("[framework] {} 试启动通过", pkg.name);

    let _ = app.emit(
        "sidecar://event",
        json!({ "status": "runtime_installed", "framework": pkg.framework }),
    );
    Ok(())
}

/// 把解压产物放进目标目录：解压结果若只有一层 wrapper 目录（官方包常见），剥掉该层；
/// 否则（平铺 zip）内容原样。主包与附件共用，无特判。
fn place_extracted(src: &Path, dest: &Path) -> Result<(), String> {
    let entries: Vec<_> = std::fs::read_dir(src)
        .map_err(|e| format!("read_dir {}: {e}", src.display()))?
        .filter_map(|e| e.ok())
        .collect();
    // 恰好一个顶层目录且没有其他内容 → 视为 wrapper，剥层
    let single_dir = entries.len() == 1
        && entries[0].file_type().map(|t| t.is_dir()).unwrap_or(false);
    let from: Vec<_> = if single_dir {
        std::fs::read_dir(entries[0].path())
            .map_err(|e| format!("read_dir {}: {e}", entries[0].path().display()))?
            .filter_map(|e| e.ok())
            .collect()
    } else {
        entries
    };
    if from.is_empty() {
        return Err(format!("解压结果为空: {}", src.display()));
    }
    for e in from {
        let target = dest.join(e.file_name());
        std::fs::rename(e.path(), &target)
            .map_err(|err| format!("move {} → {}: {err}", e.path().display(), target.display()))?;
    }
    Ok(())
}

/// 试启动验证框架（不带模型）
/// 目的：确认 exe + DLL 链能真正启动（文件在 ≠ 能跑；缺 DLL 会秒退/无法加载）。
/// 参数与就绪判定全部来自 RuntimePkg 数据（port_base / smoke_args / smoke_probe），本函数无框架分支：
/// - HttpHealth: 无模型也能起 HTTP 服务，健康端点返回 OK → 就绪即通过（如 llama-server /health）
/// - StderrKeywords: 必须有模型配置才能起服务；无模型启动会走到 recognizer 配置校验并报"缺模型"
///   退出 —— 能执行到这一步 = exe+DLL 链完好。判据：退出时 stderr 命中任一给定关键词（非 DLL 加载失败）。
fn smoke_test_runtime(pkg: &RuntimePkg) -> Result<(), String> {
    let dir = runtime_dir_for(pkg);
    let exe = dir.join(pkg.marker);
    if !exe.exists() {
        return Err(format!("{} 不存在", exe.display()));
    }
    if matches!(pkg.smoke_probe, SmokeProbe::PythonWorker) {
        let output = std::process::Command::new(&exe)
            .args(pkg.smoke_args)
            .current_dir(&dir)
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("Python worker 试启动失败: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if output.status.success() && stdout.contains("\"ok\": true") {
            return Ok(());
        }
        return Err(format!("Python worker smoke test 失败：退出={}，stdout={}，stderr={}", output.status, stdout.trim(), stderr.trim()));
    }
    // 随机端口（避开默认 8931/9002 与已运行实例冲突；基线来自数据表的 port_base）
    let port = 20000 + (std::process::id() as u16 % 1000) + pkg.port_base;
    let mut cmd = std::process::Command::new(&exe);
    crate::process_hidden::hide_console_window(&mut cmd);
    // 试启动参数来自数据表；"$PORT" 占位符替换为实际端口，其余原样、顺序不变
    let port_arg = port.to_string();
    cmd.args(
        pkg.smoke_args
            .iter()
            .map(|a| if *a == "$PORT" { port_arg.as_str() } else { *a }),
    );
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        // 接住 stderr：sherpa 的"缺模型"诊断走 stderr，需读取判断退出原因
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("试启动失败: {e}"))?;

    // stderr 收集线程（避免管道写满阻塞子进程）
    let Some(mut stderr) = child.stderr.take() else {
        return Err("无法接管子进程 stderr".into());
    };
    let stderr_handle = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).to_string()
    });

    // 就绪判定方式来自数据表：HttpHealth → 轮询健康端点；StderrKeywords → 退出 + stderr 关键词
    let (health_path, stderr_keywords) = match &pkg.smoke_probe {
        SmokeProbe::HttpHealth { path } => (Some(*path), None),
        SmokeProbe::StderrKeywords { exit_and_stderr_contains_any } => {
            (None, Some(*exit_and_stderr_contains_any))
        }
        SmokeProbe::PythonWorker => unreachable!(),
    };

    // 轮询最多 6 秒：等就绪（HTTP 健康端点）或进程退出（无服务端点框架）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
    let mut ready = false;
    let mut exited: Option<std::process::ExitStatus> = None;
    while std::time::Instant::now() < deadline {
        if let Ok(Some(st)) = child.try_wait() {
            exited = Some(st);
            break;
        }
        if let Some(path) = health_path {
            if let Ok(resp) = reqwest::blocking::Client::new()
                .get(format!("http://127.0.0.1:{}{}", port, path))
                .timeout(std::time::Duration::from_millis(800))
                .send()
            {
                if resp.status().is_success() {
                    ready = true;
                    break;
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    let _ = child.kill();
    let _ = child.wait();
    let stderr_text = stderr_handle.join().unwrap_or_default();

    if ready {
        return Ok(()); // 健康端点就绪
    }
    // 无服务端点框架：退出且 stderr 命中任一关键词 → DLL 链完好，通过
    //   （缺 DLL 时进程无法加载 → CreateProcess/加载器错误或空白秒退，走不到参数解析）
    if let Some(kws) = stderr_keywords {
        let missing_model = kws.iter().any(|kw| stderr_text.contains(kw));
        if missing_model && exited.is_some() {
            return Ok(());
        }
        return Err(format!(
            "sherpa 启动未通过：退出={}，stderr: {}",
            exited
                .and_then(|s| s.code())
                .map(|c| c.to_string())
                .unwrap_or_else(|| "仍在运行".into()),
            stderr_text.trim()
        ));
    }
    Err(format!("llama 6 秒内未就绪（端口 {port}），stderr: {}", stderr_text.trim()))
}

/// 校验框架完整性（marker 存在 + 非空 + aux 运行库齐全）
pub fn verify_runtime(framework: &str) -> bool {
    RUNTIME_PACKAGES
        .iter()
        .find(|p| p.framework == framework)
        .map(|p| {
            let d = runtime_dir_for(p);
            d.join(p.marker).exists()
                && d.read_dir().map(|mut r| r.next().is_some()).unwrap_or(false)
                && p.aux_files.iter().all(|f| d.join(f).exists())
        })
        .unwrap_or(false)
}

/// 尝试用 7-Zip 解压（一次）
fn extract_with_7z(pkg_path: &Path, dest: &Path) -> Result<(), String> {
    for exe in [
        "C:\\Program Files\\7-Zip\\7z.exe",
        "C:\\Program Files (x86)\\7-Zip\\7z.exe",
        "D:\\app\\7-Zip\\7z.exe",
    ] {
        let p = std::path::Path::new(exe);
        if !p.exists() {
            continue;
        }
        let mut cmd = std::process::Command::new(p);
        crate::process_hidden::hide_console_window(&mut cmd);
        let st = cmd
            .args(["x", pkg_path.to_str().unwrap_or(""), "-y"])
            .arg(format!("-o{}", dest.display()))
            .status()
            .map_err(|e| format!("7z start failed: {e}"))?;
        if st.success() {
            return Ok(());
        }
    }
    Err("7-Zip 不可用或失败".into())
}

/// 尝试用 bsdtar 解压（System32 全路径，避免 GNU tar 把 D: 当远程主机；
/// bsdtar 一次处理 tar.bz2 的压缩层+tar 层）
fn extract_with_bsdtar(pkg_path: &Path, dest: &Path) -> Result<(), String> {
    let bsdtar = std::path::Path::new(
        &std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()),
    )
    .join("System32\\tar.exe");
    if !bsdtar.exists() {
        return Err("bsdtar 不存在".into());
    }
    let mut cmd = std::process::Command::new(&bsdtar);
    crate::process_hidden::hide_console_window(&mut cmd);
    let st = cmd
        .arg("-xf")
        .arg(pkg_path)
        .arg("-C")
        .arg(dest)
        .status()
        .map_err(|e| format!("bsdtar start failed: {e}"))?;
    if st.success() {
        Ok(())
    } else {
        Err(format!("bsdtar 失败（退出码: {}）", st.code().unwrap_or(-1)))
    }
}

/// 解压压缩包（zip / tar.bz2 / tar.gz 通用）。
/// 关键：tar.bz2/tar.gz 是「压缩层 + tar 层」两层 —— 7z 单次只解掉压缩层、吐出内层 .tar。
/// 因此本函数支持递归：解完后若目标根出现内层 .tar，继续解、删掉内层包，直到没有为止。
pub fn extract_archive(pkg_path: &Path, dest: &Path) -> Result<(), String> {
    let name = pkg_path
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let is_two_layer = name.ends_with(".tar.bz2") || name.ends_with(".tar.gz") || name.ends_with(".tgz");
    // 先按类型选优解压器
    let first = if is_two_layer {
        extract_with_bsdtar(pkg_path, dest).or_else(|_| extract_with_7z(pkg_path, dest))
    } else {
        extract_with_7z(pkg_path, dest).or_else(|_| extract_with_bsdtar(pkg_path, dest))
    };
    first.map_err(|e| format!("解压失败: {e}"))?;

    // 递归展开：7z 只解出内层 .tar 时，把它也解开并删除（最多 3 层，防恶意包）
    for _ in 0..3 {
        let mut inner: Option<PathBuf> = None;
        if let Ok(rd) = std::fs::read_dir(dest) {
            for e in rd.flatten() {
                let f = e.file_name().to_string_lossy().to_lowercase();
                let is_tar = f.ends_with(".tar") || f.ends_with(".tar.bz2") || f.ends_with(".tar.gz");
                if is_tar && e.path() != pkg_path {
                    inner = Some(e.path());
                    break;
                }
            }
        }
        let Some(tar_path) = inner else { break };
        // 内层若是 .tar.bz2/.tar.gz（理论上不会，保险起见）先解压缩层
        let t = tar_path.file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        if t.ends_with(".tar.bz2") || t.ends_with(".tar.gz") || t.ends_with(".tgz") {
            let _ = extract_with_bsdtar(&tar_path, dest);
        } else {
            let _ = extract_with_7z(&tar_path, dest);
        }
        let _ = std::fs::remove_file(&tar_path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 开发脚本 benchmarks/setup.ps1 与本表版本必须一致（防"改了 Rust 忘了改脚本"）。
    /// 脚本里 sherpa 版本是 `$ver = "1.13.6"` 变量拼接（URL 中写 `v$ver`），
    /// 故比对去掉前导 v 的裸版本号。
    #[test]
    fn test_dev_script_versions_match_packages() {
        let script = include_str!("../../../benchmarks/setup.ps1");
        for p in RUNTIME_PACKAGES {
            // PyTorch assets use the separate runtime-assets pipeline.
            if p.framework.starts_with("pytorch-") {
                continue;
            }
            let needle = p.version.trim_start_matches('v');
            assert!(
                script.contains(needle),
                "benchmarks/setup.ps1 中找不到 {} 的版本 {needle}（两处已漂移）",
                p.name
            );
        }
    }

    #[test]
    fn test_packages_defined() {
        // 至少 2 个框架定义（llama + sherpa）
        assert!(RUNTIME_PACKAGES.len() >= 2);
        for p in RUNTIME_PACKAGES {
            assert!(!p.url.is_empty());
            assert!(!p.marker.is_empty());
        }
    }

    #[test]
    fn test_runtime_status_shape() {
        let s = runtime_status();
        assert_eq!(s["status"], "runtime_status");
        assert!(s["packages"].as_array().unwrap().len() >= 2);
        for p in s["packages"].as_array().unwrap() {
            let ver = p["version"].as_str().unwrap_or("");
            assert!(!ver.is_empty(), "每个框架包必须带版本字段: {p}");
        }
    }

    #[test]
    fn test_manifest_parsing_tolerates_bom_and_rejects_mismatch() {
        let pkg = RUNTIME_PACKAGES.iter().find(|p| p.framework == "pytorch-cuda130").unwrap();
        let dir = std::env::temp_dir().join(format!("voxflow-manifest-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("good.json");
        std::fs::write(
            &good,
            "\u{feff}{\"worker_protocol\":1,\"variant\":\"cuda130\",\"torch\":\"2.14.0+cu130\",\"script\":\"worker.py\"}",
        )
        .unwrap();
        assert!(runtime_manifest_matches(pkg, &good), "BOM 前缀不应导致 manifest 校验失败");

        let wrong = dir.join("wrong.json");
        std::fs::write(&wrong, "{\"worker_protocol\":1,\"variant\":\"cpu\",\"torch\":\"2.14.0+cu130\",\"script\":\"worker.py\"}").unwrap();
        assert!(!runtime_manifest_matches(pkg, &wrong), "variant 不一致必须判定失败");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_pytorch_variants_share_engine_and_cpu_capability() {
        let cpu = RUNTIME_PACKAGES.iter().find(|p| p.framework == "pytorch-cpu").unwrap();
        let cuda = RUNTIME_PACKAGES.iter().find(|p| p.framework == "pytorch-cuda130").unwrap();
        assert_eq!(cpu.engine, "pytorch");
        assert_eq!(cuda.engine, "pytorch");
        assert!(cpu.supports_cpu && !cpu.supports_cuda);
        assert!(cuda.supports_cpu && cuda.supports_cuda);
        assert!(cpu.unpacked_bytes.is_some() && cuda.unpacked_bytes.is_some());
        assert!(cpu.sha256.len() == 64 && cuda.sha256.len() == 64);
        // CPU 单包；CUDA 主包 + 运行库辅包（辅包必须与主包同装，缺任一行都不完整）
        assert!(cpu.aux_url.is_none() && cpu.aux_sha256.is_empty());
        assert_eq!(cuda.aux_dir, "Lib/site-packages/torch/lib");
        assert_eq!(cuda.aux_sha256.len(), 64);
        assert_eq!(cuda.aux_files, CUDA130_AUX_FILES);
        assert!(cuda.aux_files.iter().all(|f| f.starts_with("Lib/site-packages/torch/lib/")));
        assert!(
            cuda.aux_files.iter().any(|f| f.ends_with("torch_cuda.dll")),
            "辅包必须含 torch_cuda.dll，否则 import torch 必失败"
        );
        assert_eq!(preferred_runtime_for_device("pytorch", "cpu").unwrap().framework, "pytorch-cpu");
        assert_eq!(preferred_runtime_for_device("pytorch", "cuda").unwrap().framework, "pytorch-cuda130");
    }
}
