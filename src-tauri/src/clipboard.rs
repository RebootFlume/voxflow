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
    //
    //    关键修复：必须用 Key::V（VK 虚拟键码），不能用 Key::Unicode('v')——
    //    enigo 0.2 的 Unicode 分支在 Windows 走 KEYEVENTF_SCANCODE 发「扫描码」，
    //    但 VkKeyScanW 返回的是虚拟键码（0x56），被填进扫描码位置（真实 V 键
    //    扫描码是 0x2F），导致 Ctrl+V 组合在很多应用（VS Code/浏览器/IM）收不到
    //    → 上屏失败。Key::V 直接走 VK 分支（VK_V），与 Ctrl（VK_CONTROL）同为
    //    虚拟键码，组合键可靠。
    //
    //    RAII 风格保证：即使中间某步失败，也确保 Ctrl 释放，避免卡键导致
    //    「上一次失败 → 后续一直失败」的连锁问题。
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {e}"))?;
    std::thread::sleep(std::time::Duration::from_millis(20));

    enigo
        .key(enigo::Key::Control, enigo::Direction::Press)
        .map_err(|e| format!("ctrl down: {e:?}"))?;

    // Ctrl 按下与 V 之间留时序（部分应用对组合键时序敏感）
    std::thread::sleep(std::time::Duration::from_millis(15));

    let v_result = enigo.key(enigo::Key::V, enigo::Direction::Click);

    // 无论 V 是否成功，都先释放 Ctrl（防止卡键）
    let ctrl_result = enigo.key(enigo::Key::Control, enigo::Direction::Release);
    std::thread::sleep(std::time::Duration::from_millis(15));

    v_result.map_err(|e| format!("v click: {e:?}"))?;
    ctrl_result.map_err(|e| format!("ctrl up: {e:?}"))?;

    // 4. 恢复原剪贴板（延时 200ms，确保目标应用完成粘贴——
    //    过早恢复可能打断粘贴中的应用 → 「时准时不准」）
    if let Some(orig) = original {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let _ = cb.set_text(orig);
    }

    Ok(())
}
