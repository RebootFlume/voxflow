use arboard::Clipboard;
use enigo::{Enigo, Keyboard, Settings};

/// 上屏链路（规格 §8.2）：arboard 写剪贴板 + enigo 模拟 Ctrl+V
/// 必须双库配合：enigo 不操作剪贴板，arboard 不模拟按键。
///
/// 对齐 CapsWriter 行为：粘贴前保存原剪贴板，粘贴后恢复，
/// 避免覆盖用户剪贴板内容。
pub fn paste_text(text: &str) -> Result<(), String> {
    // 1. 保存原剪贴板
    let mut cb = Clipboard::new().map_err(|e| format!("clipboard open: {e}"))?;
    let original = cb.get_text().ok();

    // 2. 复制要粘贴的文本
    cb.set_text(text.to_owned())
        .map_err(|e| format!("clipboard write: {e}"))?;

    // 3. 模拟 Ctrl+V（粘贴到鼠标光标处）
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {e}"))?;
    std::thread::sleep(std::time::Duration::from_millis(20));
    enigo
        .key(enigo::Key::Control, enigo::Direction::Press)
        .map_err(|e| format!("ctrl down: {e:?}"))?;
    enigo
        .key(enigo::Key::Unicode('v'), enigo::Direction::Click)
        .map_err(|e| format!("v click: {e:?}"))?;
    enigo
        .key(enigo::Key::Control, enigo::Direction::Release)
        .map_err(|e| format!("ctrl up: {e:?}"))?;

    // 4. 恢复原剪贴板（短暂延时，确保粘贴完成）
    if let Some(orig) = original {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let _ = cb.set_text(orig);
    }

    Ok(())
}
