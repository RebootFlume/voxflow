use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::data_root::get_data_root(app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn read_data_file(app: AppHandle, filename: String) -> Result<Option<String>, String> {
    let path = data_dir(&app)?.join(&filename);
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_data_file(app: AppHandle, filename: String, content: String) -> Result<(), String> {
    let path = data_dir(&app)?.join(&filename);
    // 确保父目录存在（如 logs/、history/）——os error 3 根因：
    // fs::write 不会自动创建不存在的父目录
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_data_dir(app: AppHandle) -> Result<String, String> {
    data_dir(&app).map(|p| p.to_string_lossy().to_string())
}
