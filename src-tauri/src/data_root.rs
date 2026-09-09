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

/// 从 config.json 读取原始 modelRoot 字符串（未解析）。
fn raw_saved_model_root(data_root: &std::path::Path) -> Option<String> {
    let path = data_root.join(CONFIG_FILE);
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let root = v.get("models")?.get("modelRoot")?.as_str()?.trim();
    if root.is_empty() {
        None
    } else {
        Some(root.to_string())
    }
}

/// 解析保存的 modelRoot → 绝对路径（含相对路径支持）。
///
/// 规则：
///   1. 空 / 无 modelRoot → None（用默认：数据根/models）
///   2. 相对路径 → 相对「数据根」解析（便携版整目录拷走/改名后自动跟随，不再写死绝对路径）
///   3. 绝对路径 → 原样采用（用户手动选的外部目录）
///
/// 相对路径禁止 ".." 逃逸（config 手改含 .. 视为非法 → 回退默认 + 日志）。
/// 不做目录存在性校验——空目录/待下载目录是合法态（便携首次启动、预配置外部目录）。
fn resolve_saved_model_root(data_root: &std::path::Path) -> Option<PathBuf> {
    use std::path::Component;
    let raw = raw_saved_model_root(data_root)?;
    let p = PathBuf::from(&raw);
    if p.is_absolute() {
        Some(p)
    } else {
        if p.components().any(|c| matches!(c, Component::ParentDir)) {
            log::warn!(
                "[data_root] modelRoot 含非法 .. 逃逸，已回退默认: {}",
                raw
            );
            return None;
        }
        // 相对路径：相对数据根。如 "models" → <data_root>\models（便携默认）。
        // 换目录/改名后数据根随之移动，配置无需手改。
        Some(data_root.join(p))
    }
}

/// 读取 config.json 中保存的 modelRoot（无 AppHandle，命令上下文）
pub fn read_saved_model_root() -> Option<PathBuf> {
    resolve_saved_model_root(&get_data_root_raw())
}

/// 带 AppHandle 的读取（与 setup/get_data_root_info 用同一判定入口）
pub fn read_saved_model_root_with(app: &AppHandle) -> Option<PathBuf> {
    resolve_saved_model_root(&get_data_root(app))
}

/// modelRoot 存储形式（saveConfig 落盘前调用）：
/// 路径在数据根内 → 存相对（换目录自动跟随）；在数据根外（用户选的外部目录）→ 存绝对。
/// - root == data_root → 存 "."（即数据根本身）
/// - 非绝对路径输入 → 原样返回（防御，正常路径都该是绝对的）
pub fn relativize_model_root(root: &std::path::Path, data_root: &std::path::Path) -> String {
    match root.strip_prefix(data_root) {
        Ok(rel) if rel.as_os_str().is_empty() => ".".to_string(),
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => root.to_string_lossy().replace('\\', "/"),
    }
}

/// 无 AppHandle 版本（命令上下文：set_model_root sidecar 存库前用它转相对）
pub fn relativize_model_root_raw(root: &std::path::Path) -> String {
    relativize_model_root(root, &get_data_root_raw())
}

/// 带 AppHandle 版本
pub fn relativize_model_root_with(root: &std::path::Path, app: &AppHandle) -> String {
    relativize_model_root(root, &get_data_root(app))
}

/// Tauri 命令：返回 modelRoot 的「存储形式」（供 saveConfig 落盘前转换）。
/// 数据根内 → 相对（"models" / "." / "模型库B"）；数据根外 → 绝对。
/// 输入已相对（如 loadConfig 早于 Rust 数据根回填的竞态窗口）→ 原样返回，不二次拼路径。
#[tauri::command]
pub fn rust_storage_model_root(app: AppHandle, root: String) -> Result<String, String> {
    use std::path::Component;
    let raw = root.trim().to_string();
    if raw.is_empty() {
        return Ok("models".to_string()); // 空 → 默认相对值
    }
    let p = PathBuf::from(&raw);
    if p.is_absolute() {
        return Ok(relativize_model_root_with(&p, &app));
    }
    // 已相对：含 .. 逃逸拒绝（保持非法态不落盘），否则原样
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("model root 相对路径禁止 .. 逃逸: {raw}"));
    }
    Ok(raw.replace('\\', "/"))
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

    // ── modelRoot 相对/绝对解析（核心规则） ──────────────────────────

    /// 在临时数据根写 config.json 并返回其路径
    fn write_cfg(data_root: &std::path::Path, model_root_val: &str) {
        std::fs::create_dir_all(data_root).unwrap();
        std::fs::write(
            data_root.join(CONFIG_FILE),
            format!(
                r#"{{"models": {{"modelRoot": "{}"}}}}"#,
                model_root_val.replace('\\', "\\\\")
            ),
        )
        .unwrap();
    }

    #[test]
    fn relative_models_resolves_under_data_root() {
        let tmp = std::env::temp_dir().join("voxflow-dr-test-relative_models");
        write_cfg(&tmp, "models");
        let got = resolve_saved_model_root(&tmp).unwrap();
        assert_eq!(got, tmp.join("models"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn relative_custom_dir_resolves_under_data_root() {
        let tmp = std::env::temp_dir().join("voxflow-dr-test-rel_custom");
        write_cfg(&tmp, "模型库B");
        let got = resolve_saved_model_root(&tmp).unwrap();
        assert_eq!(got, tmp.join("模型库B"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn absolute_external_dir_kept_as_is() {
        let tmp = std::env::temp_dir().join("voxflow-dr-test-abs_ext");
        write_cfg(&tmp, r"D:\models-external");
        let got = resolve_saved_model_root(&tmp).unwrap();
        assert_eq!(got, std::path::PathBuf::from(r"D:\models-external"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn parent_dir_escape_rejected() {
        let tmp = std::env::temp_dir().join("voxflow-dr-test-escape");
        write_cfg(&tmp, "../evil");
        assert!(resolve_saved_model_root(&tmp).is_none(), ".. 逃逸应被拒绝回退默认");
        write_cfg(&tmp, "../../../escape");
        assert!(resolve_saved_model_root(&tmp).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn empty_or_missing_root_falls_back() {
        let tmp = std::env::temp_dir().join("voxflow-dr-test-empty");
        // 无 modelRoot
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join(CONFIG_FILE), r#"{"models": {}}"#).unwrap();
        assert!(resolve_saved_model_root(&tmp).is_none());
        // 空字符串
        write_cfg(&tmp, "");
        assert!(resolve_saved_model_root(&tmp).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn relativize_inner_outer_and_self() {
        let data_root = std::path::Path::new(r"D:\voxflow\data");
        // 数据根内 → 相对
        assert_eq!(
            relativize_model_root(&data_root.join("models"), data_root),
            "models"
        );
        assert_eq!(
            relativize_model_root(&data_root.join("模型库B"), data_root),
            "模型库B"
        );
        // 数据根本身 → "."
        assert_eq!(relativize_model_root(data_root, data_root), ".");
        // 数据根外 → 绝对原样
        assert_eq!(
            relativize_model_root(std::path::Path::new(r"D:\outside"), data_root),
            "D:/outside"
        );
    }
}
