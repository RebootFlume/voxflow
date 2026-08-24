//! 录音热键：CapsLock（rdev）+ 组合键（global-shortcut）
//!
//! ⚠️ 当前录音/识别引擎尚未接入 Rust（见 audio::capture 与 inference::asr），
//! 热键目前只负责把按键状态同步到前端（`asr://status`），触发不了真实录音。
//! 接入 cpal 采集 + Rust ASR 后，在回调里补上采集与推理调用即可。

use parking_lot::Mutex;
use rdev::{listen, Event, EventType, Key};
use tauri::{AppHandle, Emitter};

/// 当前注册的快捷键字符串（如 "CapsLock" / "Alt+Space"）。由 set_hotkey 命令更新，rdev 回调读取。
static CURRENT_HOTKEY: Mutex<String> = Mutex::new(String::new());
static CAPSLOCK_LISTENING: Mutex<bool> = Mutex::new(false);

/// 启动 CapsLock 全局监听（幂等）。录音链路就绪后在此触发采集。
pub fn start_capslock_listener(app: AppHandle) {
    if *CAPSLOCK_LISTENING.lock() {
        return;
    }
    *CAPSLOCK_LISTENING.lock() = true;

    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut is_recording = false;

        let callback = move |event: Event| {
            if *CURRENT_HOTKEY.lock() != "CapsLock" {
                return;
            }
            match event.event_type {
                EventType::KeyPress(Key::CapsLock) => {
                    if !is_recording {
                        is_recording = true;
                        let _ = app2.emit("asr://status", "recording");
                    }
                }
                EventType::KeyRelease(Key::CapsLock) => {
                    if is_recording {
                        is_recording = false;
                        let _ = app2.emit("asr://status", "recognizing");
                    }
                }
                _ => {}
            }
        };
        if let Err(e) = listen(callback) {
            eprintln!("[hotkey] rdev listen error: {e:?}");
        }
    });
}

/// 设置并注册新的录音热键。
/// CapsLock → rdev 监听（已启动，只需设置 CURRENT_HOTKEY）；
/// 组合键 → tauri-plugin-global-shortcut 注册。
pub fn register_combo(app: &AppHandle, hotkey_str: &str) -> Result<(), String> {
    *CURRENT_HOTKEY.lock() = hotkey_str.to_string();

    if hotkey_str == "CapsLock" {
        return Ok(());
    }

    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let sc: Shortcut = hotkey_str
        .parse()
        .map_err(|e| format!("invalid hotkey '{hotkey_str}': {e:?}"))?;

    gs.on_shortcut(sc, move |app, _sc, event| {
        if event.state == ShortcutState::Pressed {
            let _ = app.emit("asr://status", "recording");
        } else if event.state == ShortcutState::Released {
            let _ = app.emit("asr://status", "recognizing");
        }
    })
    .map_err(|e| e.to_string())?;

    Ok(())
}
