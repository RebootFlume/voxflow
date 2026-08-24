use arboard::Clipboard;
use enigo::{Enigo, Keyboard, Settings};

/// 上屏链路（规格 §8.2）：arboard 写剪贴板 + enigo 模拟 Ctrl+V
/// 必须双库配合：enigo 不操作剪贴板，arboard 不模拟按键。
pub fn paste_text(text: &str) -> Result<(), String> {
    let mut cb = Clipboard::new().map_err(|e| format!("clipboard open: {e}"))?;
    cb.set_text(text.to_owned())
        .map_err(|e| format!("clipboard write: {e}"))?;
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
    Ok(())
}
