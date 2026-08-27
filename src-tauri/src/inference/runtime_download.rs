//! 推理框架运行时（libs）下载与检测
//!
//! libs/ 是推理引擎二进制（llama-server / sherpa-onnx），与 exe 同级存放。
//! 首次启动/框架缺失时，从 GitHub release 下载压缩包 → 解压到 exe 旁 libs/。
//!
//! 下载复用模型下载的机制：代理 env + reqwest + tar 解压。

use std::path::{Path, PathBuf};

use serde_json::json;
use tauri::{AppHandle, Emitter};

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
    /// 压缩包内顶层目录名（解压后要移出的子目录，如 "llama-cpp"）
    pub inner_dir: &'static str,
    /// 目标目录名（解压到 libs/ 下）
    pub target_dir: &'static str,
    /// 校验文件（存在即认为已安装）
    pub marker: &'static str,
}

/// 当前发布包（官方版本，固定版本号）
/// - llama.cpp: b10622（cuda-12.4，与 benchmarks/setup.ps1 一致）
/// - sherpa-onnx: v1.13.6（cuda-12.x-cudnn-9.x）
pub const RUNTIME_PACKAGES: &[RuntimePkg] = &[
    RuntimePkg {
        framework: "gguf",
        name: "llama-server",
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b10622/llama-b10622-bin-win-cuda-12.4-x64.zip",
        inner_dir: "llama-b10622-bin-win-cuda-12.4-x64",
        target_dir: "llama-cpp",
        marker: if cfg!(windows) { "llama-server.exe" } else { "llama-server" },
    },
    RuntimePkg {
        framework: "onnx",
        name: "sherpa-onnx",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.6/sherpa-onnx-v1.13.6-cuda-12.x-cudnn-9.x-onnxruntime1.27.1-win-x64-cuda.tar.bz2",
        inner_dir: "sherpa-onnx-v1.13.6-cuda-12.x-cudnn-9.x-onnxruntime1.27.1-win-x64-cuda",
        target_dir: "sherpa-onnx",
        marker: "sherpa-onnx-offline-websocket-server.exe",
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
pub fn is_runtime_installed(pkg: &RuntimePkg) -> bool {
    let dir = match pkg.framework {
        "gguf" => runtime_paths::llama_runtime_dir(),
        "onnx" => runtime_paths::sherpa_runtime_dir(),
        _ => return false,
    };
    dir.join(pkg.marker).exists()
}

/// 检测所有框架状态，返回 JSON（供前端展示）
pub fn runtime_status() -> serde_json::Value {
    let items: Vec<serde_json::Value> = RUNTIME_PACKAGES
        .iter()
        .map(|p| {
            json!({
                "framework": p.framework,
                "name": p.name,
                "installed": is_runtime_installed(p),
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

/// 某框架的运行时目录（与推理启动同一路径解析）
pub fn runtime_dir_for(pkg: &RuntimePkg) -> PathBuf {
    match pkg.framework {
        "gguf" => runtime_paths::llama_runtime_dir(),
        "onnx" => runtime_paths::sherpa_runtime_dir(),
        _ => libs_root(),
    }
}

/// 下载 + 解压一个框架到 libs/（带进度事件，可取消）
pub fn download_runtime(
    app: AppHandle,
    framework: &str,
) -> Result<(), String> {
    let pkg = RUNTIME_PACKAGES
        .iter()
        .find(|p| p.framework == framework)
        .ok_or_else(|| format!("unknown framework: {framework}"))?;

    if is_runtime_installed(pkg) {
        return Ok(()); // 已安装
    }

    // 临时目录（libs 同级，解压后移动）
    let root = libs_root();
    std::fs::create_dir_all(&root).map_err(|e| format!("create libs dir: {e}"))?;
    let tmp = root.join(format!("_runtime_{}", pkg.framework));
    if tmp.exists() {
        std::fs::remove_dir_all(&tmp).ok();
    }
    std::fs::create_dir_all(&tmp).map_err(|e| format!("create tmp: {e}"))?;

    // 1. 下载（代理 env + reqwest，同模型下载机制）
    use std::io::Read;
    let proxy = crate::model_manager::get_proxy();
    let _env_guard = crate::model_manager::ENV_SCOPE_LOCK.lock();
    crate::model_manager::apply_proxy_env(&proxy);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .build()
        .map_err(|e| format!("HTTP client build failed: {e}"))?;
    let mut resp = client.get(pkg.url).send().map_err(|e| format!("HTTP GET failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {}", resp.status(), pkg.url));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut buf = Vec::new();
    let mut last_emit = std::time::Instant::now();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = resp.read(&mut chunk).map_err(|e| format!("read error: {e}"))?;
        if n == 0 { break; }
        buf.extend_from_slice(&chunk[..n]);
        downloaded += n as u64;
        if last_emit.elapsed().as_millis() > 500 {
            let pct = if total > 0 { (downloaded as f64 / total as f64 * 100.0) as u32 } else { 0 };
            let _ = app.emit(
                "sidecar://event",
                json!({
                    "status": "runtime_download_progress",
                    "framework": pkg.framework,
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
        json!({ "status": "runtime_download_progress", "framework": pkg.framework, "progress": 100u32 }),
    );

    // 2. 写临时压缩包 + 解压
    // 注意：PATH 里可能有 GNU tar（Git 自带），会把 "D:" 当远程主机导致失败。
    // 因此优先用 7-Zip（若已安装），回退 Windows 自带 bsdtar（System32\tar.exe 全路径）。
    let pkg_path = tmp.join("_runtime.pkg");
    std::fs::write(&pkg_path, &buf).map_err(|e| format!("write tmp pkg: {e}"))?;
    eprintln!("[runtime] extracting {} bytes for {}", buf.len(), pkg.framework);
    let status = extract_archive(&pkg_path, &tmp);
    let _ = std::fs::remove_file(&pkg_path);
    status.map_err(|e| format!("解压失败: {e}"))?;

    // 3. 把内层目录移到 libs/<target_dir>（压缩包内顶层目录可能叫 llama-cpp / sherpa-onnx）
    let src = tmp.join(pkg.inner_dir);
    let dest = root.join(pkg.target_dir);
    if src.exists() {
        if dest.exists() {
            std::fs::remove_dir_all(&dest).ok();
        }
        std::fs::rename(&src, &dest).map_err(|e| format!("move to libs: {e}"))?;
    } else {
        // 内层目录不存在（官方 llama zip 直接平铺）→ 统一移到 libs/<target_dir>/ 下
        let dest_dir = root.join(pkg.target_dir);
        if dest_dir.exists() {
            std::fs::remove_dir_all(&dest_dir).ok();
        }
        std::fs::create_dir_all(&dest_dir).map_err(|e| format!("create target dir: {e}"))?;
        let entries: Vec<_> = std::fs::read_dir(&tmp)
            .map_err(|e| format!("read_dir tmp: {e}"))?
            .filter_map(|e| e.ok())
            .collect();
        for e in entries {
            let target = dest_dir.join(e.file_name());
            std::fs::rename(e.path(), &target).map_err(|e| format!("move: {e}"))?;
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);

    if !is_runtime_installed(pkg) {
        return Err(format!("解压完成但未找到 {}，包可能不完整", pkg.marker));
    }

    // 试启动验证：spawn 引擎（无模型）+ /health 轮询，确认 exe + DLL 齐全
    // （marker 文件存在 ≠ 能跑；缺 DLL 时 spawn 即失败/秒退）
    match smoke_test_runtime(pkg) {
        Ok(()) => {
            eprintln!("[runtime] smoke test OK: {}", pkg.framework);
        }
        Err(e) => {
            return Err(format!("试启动验证失败（可能 DLL 缺失）：{e}"));
        }
    }

    let _ = app.emit(
        "sidecar://event",
        json!({ "status": "runtime_installed", "framework": pkg.framework }),
    );
    Ok(())
}

/// 试启动验证框架（不带模型，纯起服务 + /health 轮询）
/// - llama-server: 无 -m 也能起 HTTP 服务（加载 0 模型），/health 返回 OK
/// - sherpa websocket server: 纯起监听端口，轮询端口可连即通过
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
        // sherpa websocket server：无模型启动（不带 --paraformer 等）
        cmd.args(["--port", &port.to_string()]);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("试启动失败: {e}"))?;

    // 轮询 6 秒等就绪
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
    let mut ready = false;
    while std::time::Instant::now() < deadline {
        // 进程秒退（缺 DLL）→ 立即失败
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
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
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    let _ = child.kill();
    let _ = child.wait();
    if ready {
        Ok(())
    } else {
        Err(format!("6 秒内未就绪（端口 {port}），引擎可能缺失 DLL 或启动失败"))
    }
}

/// 校验框架完整性（marker 存在 + 非空）
pub fn verify_runtime(framework: &str) -> bool {
    RUNTIME_PACKAGES
        .iter()
        .find(|p| p.framework == framework)
        .map(|p| {
            let d = runtime_dir_for(p);
            d.join(p.marker).exists() && d.read_dir().map(|mut r| r.next().is_some()).unwrap_or(false)
        })
        .unwrap_or(false)
}

/// 解压压缩包（zip / tar.bz2 通用）
/// 优先 7-Zip（常见安装位置），回退 Windows 自带 bsdtar（System32 全路径，避免 GNU tar 把 D: 当远程主机）
pub fn extract_archive(pkg_path: &Path, dest: &Path) -> Result<(), String> {
    // 1. 7-Zip（若已安装）
    for exe in [
        "C:\\Program Files\\7-Zip\\7z.exe",
        "C:\\Program Files (x86)\\7-Zip\\7z.exe",
        "D:\\app\\7-Zip\\7z.exe",
    ] {
        let p = std::path::Path::new(exe);
        if p.exists() {
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
    }
    // 2. Windows 自带 bsdtar（System32 全路径）
    let bsdtar = std::path::Path::new(&std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))
        .join("System32\\tar.exe");
    if bsdtar.exists() {
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
            return Ok(());
        }
    }
    // 3. 回退：tar（PATH 里的，最后手段）
    let mut cmd = std::process::Command::new("tar");
    crate::process_hidden::hide_console_window(&mut cmd);
    let st = cmd
        .arg("-xf")
        .arg(pkg_path)
        .arg("-C")
        .arg(dest)
        .status()
        .map_err(|e| format!("tar start failed: {e}"))?;
    if st.success() {
        Ok(())
    } else {
        Err(format!("所有解压器均失败（退出码: {}", st.code().unwrap_or(-1)))
    }
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
