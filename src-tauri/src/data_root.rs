//! 统一数据根目录（安装模式 vs 便携模式）
//!
//! 同一时间只使用一个数据根，不存在「既在这又在那」：
//! - 便携模式：exe 旁有 `data\` 文件夹 → 数据根 = `<exe>\data\`
//! - 安装模式：默认 → 数据根 = `%APPDATA%\com.voxflow.app\`
//!
//! 所有用户数据（models / config.json / history / logs）都从这一个根派生。

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 计算统一数据根目录（便携检测 + AppData 兜底）
pub fn get_data_root(app: &AppHandle) -> PathBuf {
    // 便携模式：exe 旁有 data\ 文件夹
    if let Ok(exe_dir) = app.path().executable_dir() {
        let portable = exe_dir.join("data");
        if portable.is_dir() {
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

/// 当前是否便携模式（用于前端展示）
pub fn is_portable(app: &AppHandle) -> bool {
    if let Ok(exe_dir) = app.path().executable_dir() {
        exe_dir.join("data").is_dir()
    } else {
        false
    }
}
