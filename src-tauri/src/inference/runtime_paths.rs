//! 推理引擎运行时目录（libs）
//!
//! 单一逻辑：libs 永远在 exe 同级目录。
//! - 打包版（安装/便携）：libs/ 与 exe 同级（用户从「推理框架」页下载解压到那）
//! - 开发版：libs/ 也在 exe 同级（target\debug\libs），开发时把项目根 libs 复制过去
//!
//! 不再做多路径回退（环境变量 / _up_ / 项目根）——统一只认 exe 目录，
//! 避免跨项目/残留目录误判。

use std::path::PathBuf;

/// 当前 exe 所在目录
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// libs 根目录（exe 旁）
pub fn libs_dir() -> PathBuf {
    exe_dir()
        .map(|d| d.join("libs"))
        .unwrap_or_else(|| PathBuf::from("libs"))
}

/// llama-cpp 运行时目录（含 llama-server.exe）
pub fn llama_runtime_dir() -> PathBuf {
    libs_dir().join("llama-cpp")
}

/// sherpa-onnx 运行时目录（含 websocket server exe）
/// 优先环境变量 SHERPA_CPP_DIR（测试/特殊部署），否则 exe 旁 libs/sherpa-onnx
pub fn sherpa_runtime_dir() -> PathBuf {
    if let Ok(env_dir) = std::env::var("SHERPA_CPP_DIR") {
        let p = PathBuf::from(env_dir);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    libs_dir().join("sherpa-onnx")
}

/// exe 同级目录（libs / data 等资源的基准）
pub fn app_dir() -> PathBuf {
    exe_dir().unwrap_or_else(|| PathBuf::from("."))
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
