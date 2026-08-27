//! 统一数据根目录（安装模式 vs 便携模式）
//!
//! 判定依据：exe 旁是否存在 `portable.txt` 标记文件（打包便携版时放入）。
//! - 便携模式：有 portable.txt → 数据根 = `<exe>\data\`（首次运行自动创建）
//! - 安装模式：无 → 数据根 = `%APPDATA%\com.voxflow.app\`
//!
//! 所有用户数据（models / config.json / history / logs）都从这一个根派生。

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 配置文件（数据根下）
pub const CONFIG_FILE: &str = "config.json";

/// 便携标记文件名（打包便携版时与 exe 同级放入）
pub const PORTABLE_MARKER: &str = "portable.txt";

/// 无 AppHandle 的便携判定（命令上下文用 current_exe）
pub fn is_portable_raw() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .map(|d| d.join(PORTABLE_MARKER).is_file())
        .unwrap_or(false)
}

/// 无 AppHandle 的数据根（命令上下文）
pub fn get_data_root_raw() -> PathBuf {
    if is_portable_raw() {
        let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
        if let Some(exe_dir) = exe_dir {
            let portable = exe_dir.join("data");
            let _ = std::fs::create_dir_all(portable.join("models"));
            return portable;
        }
    }
    dirs::data_dir()
        .unwrap_or_else(|| std::env::temp_dir().join("voxflow-data"))
        .join("com.voxflow.app")
}

/// 当前是否便携模式（exe 旁有 portable.txt）
/// 注意：不用 app.path().executable_dir()，因为它在 Windows 上返回 None（Tauri 2 bug）
pub fn is_portable(_app: &AppHandle) -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .map(|d| d.join(PORTABLE_MARKER).is_file())
        .unwrap_or(false)
}

/// 计算统一数据根目录（便携 marker + AppData 兜底）
pub fn get_data_root(app: &AppHandle) -> PathBuf {
    if is_portable(app) {
        // 便携模式：exe 旁 data\（首次运行自动创建，含 models）
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()));
        if let Some(exe_dir) = exe_dir {
            let portable = exe_dir.join("data");
            let _ = std::fs::create_dir_all(portable.join("models"));
            return portable;
        }
    }
    // 安装模式：AppData（%APPDATA%\com.voxflow.app）
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("voxflow-data"))
}

/// 数据根下的 models 目录
pub fn models_dir(app: &AppHandle) -> PathBuf {
    get_data_root(app).join("models")
}

/// 无 AppHandle 的数据根下的 models 目录（命令上下文）
pub fn models_dir_raw() -> PathBuf {
    get_data_root_raw().join("models")
}

/// 默认模型根：便携=exe旁data\models，安装=%APPDATA%\com.voxflow.app\models
pub fn default_model_root() -> PathBuf {
    get_data_root_raw().join("models")
}

/// 带 AppHandle 的默认模型根（与 setup/get_data_root_info 用同一判定入口）
pub fn default_model_root_with(app: &AppHandle) -> PathBuf {
    get_data_root(app).join("models")
}

/// 读取 config.json 中保存的 modelRoot（前端持久化的用户选择）
/// 优先于便携/安装默认值：用户改过路径后重启应保留，而非被默认值覆盖。
pub fn read_saved_model_root() -> Option<PathBuf> {
    let path = get_data_root_raw().join(CONFIG_FILE);
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let root = v
        .get("models")?
        .get("modelRoot")?
        .as_str()?
        .trim();
    if root.is_empty() {
        return None;
    }
    let p = PathBuf::from(root);
    if p.is_absolute() {
        Some(p)
    } else {
        None // 非绝对路径视为无效配置，回退默认
    }
}

/// 带 AppHandle 的读取（与 setup/get_data_root_info 用同一判定入口）
pub fn read_saved_model_root_with(app: &AppHandle) -> Option<PathBuf> {
    let path = get_data_root(app).join(CONFIG_FILE);
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let root = v
        .get("models")?
        .get("modelRoot")?
        .as_str()?
        .trim();
    if root.is_empty() {
        return None;
    }
    let p = PathBuf::from(root);
    if p.is_absolute() {
        Some(p)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_detection_uses_exe_dir() {
        // 模拟：current_exe 所在目录有 portable.txt → 便携
        let exe = std::env::current_exe().unwrap();
        let dir = exe.parent().unwrap();
        let marker = dir.join(PORTABLE_MARKER);
        // 测试目录不应有 marker（正常 cargo test 目录没有）
        assert!(!marker.exists(), "test dir should not have portable.txt");
        assert!(!is_portable_raw());
    }
}
