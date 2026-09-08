//! 录音热键：CapsLock（rdev）+ 组合键（global-shortcut）
//!
//! 按下 → 开始 cpal 录音；松开 → 停止录音 → llama-server 转写 → emit 结果。
//!
//! 线程模型（避免 cpal::Stream 非 Send 问题）：
//! - rdev 回调线程：只通过 mpsc channel 发「开始/停止」命令，绝不直接碰 AudioCapture
//! - 录音线程：持有 AudioCapture（cpal Stream 在本线程创建/销毁），
//!   收到停止命令后在同一线程内完成转写（HTTP，不碰 cpal），再 emit 结果

use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};

use parking_lot::Mutex as PLMutex;
use rdev::{listen, Event, EventType, Key};
use tauri::{AppHandle, Emitter};

/// 当前注册的快捷键字符串（如 "CapsLock" / "Alt+Space"）。由 set_hotkey 命令更新，rdev 回调读取。
static CURRENT_HOTKEY: PLMutex<String> = PLMutex::new(String::new());
static CAPSLOCK_LISTENING: PLMutex<bool> = PLMutex::new(false);

/// 录音命令通道发送端（rdev 回调 → 录音线程）
static CAPTURE_TX: OnceLock<Sender<CaptureCmd>> = OnceLock::new();

#[derive(Debug)]
enum CaptureCmd {
    /// 开始录音
    Start,
    /// 停止录音并转写
    Stop(AppHandle),
}

/// 启动录音线程（幂等）。线程内持有 cpal 输入流，接收 Start/Stop 命令。
fn start_capture_worker(app: AppHandle) {
    let (tx, rx) = channel::<CaptureCmd>();
    let _ = CAPTURE_TX.set(tx);

    std::thread::Builder::new()
        .name("tts-capture".into())
        .spawn(move || {
            let mut capture = crate::audio::capture::AudioCapture::new(16_000);
            while let Ok(cmd) = rx.recv() {
                match cmd {
                    CaptureCmd::Start => {
                        if let Err(e) = capture.start() {
                            eprintln!("[capture] start error: {e}");
                            let _ = app.emit("sidecar://event", serde_json::json!({
                                "status": "recognition_error",
                                "error": format!("录音启动失败: {e}"),
                            }));
                        }
                    }
                    CaptureCmd::Stop(app2) => {
                        let samples = match capture.stop() {
                            Ok(s) => s,
                            Err(e) => {
                                eprintln!("[capture] stop error: {e}");
                                let _ = app2.emit("sidecar://event", serde_json::json!({
                                    "status": "recognition_error",
                                    "error": format!("录音停止失败: {e}"),
                                }));
                                continue;
                            }
                        };
                        // 太短视为误触
                        if samples.len() < 1600 {
                            let _ = app2.emit("asr://status", "idle");
                            continue;
                        }
                        // 转写：经 registry 选择当前已加载的 ASR 引擎
                        // （llama-server / sherpa，未来 PyTorch 自动生效）
                        let registry = crate::inference::registry::registry();
                        let result: Result<String, String> =
                            match registry.active_engine() {
                                Some(engine) => engine.transcribe(&samples, 16_000),
                                None => {
                                    // 无已加载引擎：自动拉起「用户最近一次选择」的 llama-server
                                    // （load_requested 跟随 UI 选择，不再硬编码 0.6B）
                                    let engine = crate::inference::llama_server::global_engine();
                                    match crate::inference::llama_server::load_requested() {
                                        Err(e) => Err(format!("引擎启动失败: {e}")),
                                        Ok(_) => engine
                                            .transcribe(&samples, 16_000)
                                            .map_err(|e| e.to_string()),
                                    }
                                }
                            };
                        // 判断用的引擎名（前端展示）
                        let engine_name = registry.active_framework();
                        match result {
                            Ok(text) => {
                                // 上屏前清理句尾标点（对齐 CapsWriter trash_punc：
                                // 语音输入尾巴不挂 。，但保留 ？！ 等有语义的标点）
                                let text = strip_trailing_punct(&text);
                                // 上屏：写剪贴板 + Ctrl+V 粘贴到鼠标光标处
                                if let Err(e) = crate::clipboard::paste_text(&text) {
                                    eprintln!("[hotkey] paste error: {e}");
                                    let _ = app2.emit("sidecar://event", serde_json::json!({
                                        "status": "recognition_error",
                                        "error": format!("识别成功但上屏失败: {e}"),
                                    }));
                                    return;
                                }
                                let _ = app2.emit("sidecar://event", serde_json::json!({
                                    "status": "recognized",
                                    "text": text,
                                    "engine": engine_name,
                                }));
                            }
                            Err(e) => {
                                // 失败时记录详细诊断（哪个引擎 + 加载状态 + 端口），供排障
                                let llama_loaded = crate::inference::llama_server::global_engine().is_loaded();
                                let sherpa_loaded = crate::inference::sherpa_asr::global_engine().is_loaded();
                                let llama_port = crate::inference::llama_server::global_engine().current_port();
                                log::warn!(
                                    "[hotkey] 转写失败: {e} | active_framework={engine_name} llama_loaded={llama_loaded}(port {llama_port}) sherpa_loaded={sherpa_loaded}"
                                );
                                let _ = app2.emit("sidecar://event", serde_json::json!({
                                    "status": "recognition_error",
                                    "error": format!("转写失败: {e}"),
                                }));
                            }
                        }
                    }
                }
            }
        })
        .expect("spawn capture worker");
}

/// 发送录音命令（失败=worker 未启动，静默忽略）
fn send_cmd(cmd: CaptureCmd) {
    if let Some(tx) = CAPTURE_TX.get() {
        let _ = tx.send(cmd);
    }
}

/// 启动 CapsLock 全局监听（幂等）。
pub fn start_capslock_listener(app: AppHandle) {
    if *CAPSLOCK_LISTENING.lock() {
        return;
    }
    *CAPSLOCK_LISTENING.lock() = true;

    // 启动录音 worker（无论用哪个热键，都要有采集线程）
    start_capture_worker(app.clone());

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
                        send_cmd(CaptureCmd::Start);
                    }
                }
                EventType::KeyRelease(Key::CapsLock) => {
                    if is_recording {
                        is_recording = false;
                        let _ = app2.emit("asr://status", "recognizing");
                        send_cmd(CaptureCmd::Stop(app2.clone()));
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
            send_cmd(CaptureCmd::Start);
        } else if event.state == ShortcutState::Released {
            let _ = app.emit("asr://status", "recognizing");
            send_cmd(CaptureCmd::Stop(app.clone()));
        }
    })
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// 清理识别文本的句尾标点（对齐 CapsWriter `trash_punc = '，。,。'` 语义）：
/// 文本 >1 字且末字符属于 {， 。 , .} 时去掉它；`？！…` 等有语义的标点保留。
/// 语音输入场景下，模型常在句尾补一个。，粘贴上屏后影响后续输入。
fn strip_trailing_punct(text: &str) -> String {
    const TRASH: &[char] = &['，', '。', ',', '.'];
    let mut s = text.trim_end().to_string();
    if s.chars().count() > 1 {
        if let Some(last) = s.chars().last() {
            if TRASH.contains(&last) {
                s.pop();
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_trailing_period() {
        assert_eq!(strip_trailing_punct("好了，满意了。"), "好了，满意了");
        assert_eq!(strip_trailing_punct("今天下午三点开会。"), "今天下午三点开会");
        assert_eq!(strip_trailing_punct("好的,"), "好的");
    }

    #[test]
    fn keep_semantic_trailing_punct() {
        // 问句/感叹/省略号保留
        assert_eq!(strip_trailing_punct("你在吗？"), "你在吗？");
        assert_eq!(strip_trailing_punct("太好了！"), "太好了！");
        assert_eq!(strip_trailing_punct("然后……"), "然后……");
    }

    #[test]
    fn keep_single_char_and_interior_punct() {
        // 单字标点整体不上屏清理（CapsWriter: (?<=.) 前置条件）
        assert_eq!(strip_trailing_punct("。"), "。");
        // 句中标点不动
        assert_eq!(strip_trailing_punct("会议，讨论。"), "会议，讨论");
    }

    #[test]
    fn strip_only_one_trailing() {
        // CapsWriter 用 re.sub($) 只删 1 个
        assert_eq!(strip_trailing_punct("完了。。"), "完了。");
    }
}
