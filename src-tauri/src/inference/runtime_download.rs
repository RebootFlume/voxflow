//! 推理框架运行时（libs）下载与检测
//!
//! libs/ 是推理引擎二进制（llama-server / sherpa-onnx），与 exe 同级存放。
//! 首次启动/框架缺失时，从 GitHub release 下载压缩包 → 解压到 exe 旁 libs/。
//!
//! 下载复用模型下载的机制：代理 env + reqwest + tar 解压。

use std::path::{Path, PathBuf};

use serde_json::json;
use tauri::Emitter;

use crate::inference::runtime_paths;

/// libs 压缩包发布信息（GitHub release 资产名 + 版本）
/// 更新引擎时改这里 + 发布新压缩包到 GitHub release。
pub struct RuntimePkg {
    /// 框架标识（与 registry 的 framework 一致）
    pub framework: &'static str,
    /// 展示名
    pub name: &'static str,
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
        name: "llama-server",
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b10622/llama-b10622-bin-win-cuda-12.4-x64.zip",
        aux_url: Some("https://github.com/ggml-org/llama.cpp/releases/download/b10622/cudart-llama-bin-win-cuda-12.4-x64.zip"),
        aux_dir: "", // 官方 cudart zip 平铺内容 → 直接放 llama-cpp 根（与主 exe 同目录）
        aux_files: &["cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll"],
        inner_dir: "llama-b10622-bin-win-cuda-12.4-x64",
        target_dir: "llama-cpp",
        marker: "llama-server.exe",
    },
    RuntimePkg {
        framework: "onnx",
        name: "sherpa-onnx",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.6/sherpa-onnx-v1.13.6-cuda-12.x-cudnn-9.x-onnxruntime1.27.1-win-x64-cuda.tar.bz2",
        // NVIDIA 运行库随装（官方包不含）→ sherpa 自包含，不依赖 llama
        aux_url: Some(SHERPA_CUDA_AUX_URL),
        aux_dir: "bin", // CUDA zip 内容 → sherpa-onnx/bin/（与官方 exe/dll 同目录）
        aux_files: SHERPA_CUDA_AUX_FILES,
        inner_dir: "sherpa-onnx-v1.13.6-cuda-12.x-cudnn-9.x-onnxruntime1.27.1-win-x64-cuda",
        target_dir: "sherpa-onnx",
        // 官方 sherpa 包根 = bin/include/lib，exe 在 bin/ 下（相对 marker，校验/启动按此解析）
        marker: "bin/sherpa-onnx-offline-websocket-server.exe",
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

/// 从 URL 提取真实压缩包扩展名（如 "tar.bz2" / "zip"），供 tmp 命名与解压分支
fn url_extension(url: &str) -> String {
    let file = url.rsplit('/').next().unwrap_or(url);
    let lower = file.to_lowercase();
    for ext in [".tar.bz2", ".tar.gz", ".tgz", ".zip", ".tar"] {
        if lower.ends_with(ext) {
            return ext.trim_start_matches('.').to_string();
        }
    }
    // 兜底：最后一段扩展
    file.rsplit('.').next().unwrap_or("zip").to_string()
}

/// 检测框架是否已安装（与推理启动共用同一路径解析：能找到启动 exe = 已下载）
/// 同时校验 aux_files（如 CUDA 运行库）完整 —— 主程序在但运行库缺失 = 未完成安装，
/// 前端据此显示"需要修复/重新下载"（否则 CUDA 会静默回退 CPU）。
pub fn is_runtime_installed(pkg: &RuntimePkg) -> bool {
    let dir = match pkg.framework {
        "gguf" => runtime_paths::llama_runtime_dir(),
        "onnx" => runtime_paths::sherpa_runtime_dir(),
        _ => return false,
    };
    if !dir.join(pkg.marker).exists() {
        return false;
    }
    pkg.aux_files.iter().all(|f| dir.join(f).exists())
}

/// 框架运行时诊断状态：ready=完整可用；incomplete=主程序在但运行库缺失（如缺 CUDA dll）；
/// missing=主程序都未下载。
pub fn runtime_diagnose(pkg: &RuntimePkg) -> (String, Vec<String>) {
    let d = runtime_dir_for(pkg);
    let marker = d.join(pkg.marker);
    if !marker.exists() {
        // 未下载（可能目录为空或不存在）
        return ("missing".into(), vec![pkg.marker.to_string()]);
    }
    let missing: Vec<String> = pkg
        .aux_files
        .iter()
        .filter(|f| !d.join(f).exists())
        .map(|f| f.to_string())
        .collect();
    if missing.is_empty() {
        ("ready".into(), Vec::new())
    } else {
        ("incomplete".into(), missing)
    }
}

/// 检测所有框架状态，返回 JSON（供前端展示）——三态：ready / incomplete / missing
pub fn runtime_status() -> serde_json::Value {
    let items: Vec<serde_json::Value> = RUNTIME_PACKAGES
        .iter()
        .map(|p| {
            let (state, missing) = runtime_diagnose(p);
            json!({
                "framework": p.framework,
                "name": p.name,
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

/// 某框架的运行时目录（与推理启动同一路径解析）
pub fn runtime_dir_for(pkg: &RuntimePkg) -> PathBuf {
    match pkg.framework {
        "gguf" => runtime_paths::llama_runtime_dir(),
        "onnx" => runtime_paths::sherpa_runtime_dir(),
        _ => libs_root(),
    }
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

fn download_to_file(
    client: &reqwest::blocking::Client,
    app: &tauri::AppHandle,
    url: &str,
    framework: &str,
    label: &str,
    out: &std::path::Path,
    span_start: u32,
    span_end: u32,
) -> Result<(), String> {
    use std::io::{Read, Write};
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create dir {}: {e}", parent.display()))?;
    }
    let mut resp = client
        .get(url)
        .send()
        .map_err(|e| format!("HTTP GET failed ({label}): {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {url}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    log::info!(
        "[framework] 下载 {label}: {}（{:.1} MB）",
        url.rsplit('/').next().unwrap_or(url),
        total as f64 / 1024.0 / 1024.0
    );
    let mut file = std::fs::File::create(out)
        .map_err(|e| format!("create tmp file {}: {e}", out.display()))?;
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = resp
            .read(&mut chunk)
            .map_err(|e| format!("read error ({label}): {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&chunk[..n])
            .map_err(|e| format!("write error ({label}): {e}"))?;
        downloaded += n as u64;
        if last_emit.elapsed().as_millis() > 500 {
            let pct = if total > 0 {
                let f = downloaded as f64 / total as f64; // 0..1
                span_start + ((span_end - span_start) as f64 * f) as u32
            } else {
                span_start
            };
            let _ = app.emit(
                "sidecar://event",
                json!({
                    "status": "runtime_download_progress",
                    "framework": framework,
                    "progress": pct,
                    "downloaded": downloaded,
                    "total": total,
                }),
            );
            last_emit = std::time::Instant::now();
        }
    }
    let _ = app.emit(
        "sidecar://event",
        json!({ "status": "runtime_download_progress", "framework": framework, "progress": span_end }),
    );
    Ok(())
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

    // 1. 代理（直连则留空；不通就明确报错）
    let proxy = crate::model_manager::get_proxy();
    let _env_guard = crate::model_manager::ENV_SCOPE_LOCK.lock();
    crate::model_manager::apply_proxy_env(&proxy);
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3600));
    // 显式挂代理（http:// 或 socks5://）。仅改 env 无效：reqwest 无 system-proxy feature。
    let proxy_str = proxy.trim().to_string();
    if !proxy_str.is_empty() {
        if let Ok(p) = reqwest::Proxy::all(&proxy_str) {
            builder = builder.proxy(p);
        } else {
            return Err(format!("代理格式无效（支持 http:// 或 socks5://）: {proxy_str}"));
        }
    }
    let client = builder
        .build()
        .map_err(|e| format!("HTTP client build failed: {e}"))?;

    log::info!("[framework] 开始下载 {} 运行时（主包 + 附件）", pkg.name);

    // 2. 下载：主包 + 附件（同一函数），进度合并为一条 0→100
    //    先 HEAD 拿两文件大小算权重，避免"每文件独立 0→100"进度条反复回跳
    let ext = url_extension(pkg.url);
    let main_arch = tmp.join(format!("main.{ext}"));
    let aux_arch = pkg.aux_url.map(|aux| {
        let ext = url_extension(aux);
        tmp.join(format!("aux.{ext}"))
    });
    let main_size = http_size(&client, pkg.url, "主程序")?;
    let aux_size = match &pkg.aux_url {
        Some(u) => http_size(&client, u, "附加运行库")?,
        None => 0u64,
    };
    let total = main_size + aux_size;
    // 主包占 [0, main_end]，附件占 [main_end, 100]
    let main_end = if total > 0 {
        (main_size as f64 / total as f64 * 100.0) as u32
    } else {
        100
    };
    download_to_file(&client, app, pkg.url, pkg.framework, "主程序", &main_arch, 0, main_end)?;
    if let Some(path) = &aux_arch {
        download_to_file(&client, app, pkg.aux_url.unwrap(), pkg.framework, "附加运行库", path, main_end, 100)?;
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
/// - llama-server: 无 -m 也能起 HTTP 服务，/health 返回 OK → 就绪即通过
/// - sherpa websocket server: 必须有模型配置才能起服务；无模型启动会走到
///   recognizer 配置校验并报"缺模型"退出 —— 能执行到这一步 = exe+DLL 链完好。
///   判据：退出时 stderr 是"缺模型/参数配置"错误（非 DLL 加载失败）。
fn smoke_test_runtime(pkg: &RuntimePkg) -> Result<(), String> {
    let dir = runtime_dir_for(pkg);
    let exe = dir.join(pkg.marker);
    if !exe.exists() {
        return Err(format!("{} 不存在", exe.display()));
    }
    // 随机端口（避开默认 8931/9002 与已运行实例冲突）
    let port = 20000 + (std::process::id() as u16 % 1000) + match pkg.framework {
        "gguf" => 0,
        "onnx" => 50,
        _ => 100,
    };
    let mut cmd = std::process::Command::new(&exe);
    crate::process_hidden::hide_console_window(&mut cmd);
    if pkg.framework == "gguf" {
        cmd.args(["--port", &port.to_string(), "--no-webui"]);
    } else {
        cmd.args(["--port", &port.to_string()]);
    }
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

    // 轮询最多 6 秒：等就绪（llama /health）或进程退出（sherpa）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
    let mut ready = false;
    let mut exited: Option<std::process::ExitStatus> = None;
    while std::time::Instant::now() < deadline {
        if let Ok(Some(st)) = child.try_wait() {
            exited = Some(st);
            break;
        }
        if pkg.framework == "gguf" {
            if let Ok(resp) = reqwest::blocking::Client::new()
                .get(format!("http://127.0.0.1:{}/health", port))
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
        return Ok(()); // llama /health 就绪
    }
    // sherpa：退出且 stderr 是"缺模型/参数配置"错误 → DLL 链完好，通过
    //   （缺 DLL 时进程无法加载 → CreateProcess/加载器错误或空白秒退，走不到参数解析）
    if pkg.framework != "gguf" {
        let missing_model = stderr_text.contains("does not exist")
            || stderr_text.contains("recognizer config")
            || stderr_text.contains("Invalid integer option")
            || stderr_text.contains("tokens:")
            || stderr_text.contains("ParseOptions")
            || stderr_text.contains("parse-options");
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
        // 调试：打印实际目录与安装状态
        eprintln!("DEBUG libs_root: {}", libs_root().display());
        for p in RUNTIME_PACKAGES {
            eprintln!("DEBUG {} installed={} dir={}", p.framework, is_runtime_installed(p), pkg_dir(p).display());
        }
    }
}
