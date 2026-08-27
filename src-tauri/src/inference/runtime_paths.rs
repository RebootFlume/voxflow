//! 推理引擎运行时目录解析（打包后兼容）
//!
//! 开发时 libs/ 在项目根；打包后 libs/ 与 exe 同级。这里统一解析：
//!   1. 环境变量（LLAMA_CPP_DIR / SHERPA_CPP_DIR）
//!   2. exe 同级 libs/（打包后）
//!   3. 项目根 libs/（开发时）
//!
//! 打包方式：Tauri bundle.resources 复制 libs 到 exe 同级（默认资源目录 _up_，
//! 但 libs 放 exe 同级更方便——用 bundle.externalBin 或 resources 配置实现）。

use std::path::{Path, PathBuf};

/// 当前 exe 所在目录（打包后 libs 的基准）
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// Tauri resources 打包位置：exe 目录下 _up_ 子目录（Windows 约定）
fn resources_dir() -> Option<PathBuf> {
    exe_dir().map(|d| d.join("_up_"))
}

/// 项目源码根（开发时 libs 的基准，CARGO_MANIFEST_DIR 的上一级）
fn project_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 解析 llama-cpp 运行时目录（含 llama-server.exe）
pub fn llama_runtime_dir() -> PathBuf {
    // 1. 环境变量
    if let Ok(env_dir) = std::env::var("LLAMA_CPP_DIR") {
        let p = PathBuf::from(env_dir);
        if p.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" }).exists() {
            return p;
        }
    }
    // 2. Tauri resources 目录（打包后，_up_ 子目录）
    if let Some(res) = resources_dir() {
        let p = res.join("libs/llama-cpp");
        if p.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" }).exists() {
            return p;
        }
        let p2 = res.join("libs");
        if p2.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" }).exists() {
            return p2;
        }
    }
    // 3. exe 同级 libs/llama-cpp（打包后）
    if let Some(exe) = exe_dir() {
        let p = exe.join("libs/llama-cpp");
        if p.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" }).exists() {
            return p;
        }
        let p2 = exe.join("libs");
        if p2.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" }).exists() {
            return p2;
        }
    }
    // 3. 项目根 libs（开发时）
    let proj = project_root();
    let p = proj.join("libs/llama-cpp");
    if p.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" }).exists() {
        return p;
    }
    proj.join("libs")
}

/// 解析 sherpa-onnx 运行时目录（含 websocket server exe）
pub fn sherpa_runtime_dir() -> PathBuf {
    // 1. 环境变量
    if let Ok(env_dir) = std::env::var("SHERPA_CPP_DIR") {
        let p = PathBuf::from(env_dir);
        if p.join("sherpa-onnx-offline-websocket-server.exe").exists() {
            return p;
        }
    }
    // 2. Tauri resources 目录（打包后，_up_ 子目录）
    if let Some(res) = resources_dir() {
        let p = res.join("libs/sherpa-onnx");
        if p.join("sherpa-onnx-offline-websocket-server.exe").exists() {
            return p;
        }
    }
    // 3. exe 同级 libs/sherpa-onnx（打包后）
    if let Some(exe) = exe_dir() {
        let p = exe.join("libs/sherpa-onnx");
        if p.join("sherpa-onnx-offline-websocket-server.exe").exists() {
            return p;
        }
    }
    // 3. 项目根 libs/sherpa-onnx（开发时）
    let proj = project_root();
    let p = proj.join("libs/sherpa-onnx");
    if p.join("sherpa-onnx-offline-websocket-server.exe").exists() {
        return p;
    }
    p
}

/// 打包后 exe 同级目录（用于定位 espeak 等资源）
pub fn app_dir() -> PathBuf {
    exe_dir().unwrap_or_else(project_root)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolves_somewhere() {
        // 至少能解析出一个目录（不 panic）
        let llama = llama_runtime_dir();
        let sherpa = sherpa_runtime_dir();
        assert!(!llama.as_os_str().is_empty());
        assert!(!sherpa.as_os_str().is_empty());
    }
}
