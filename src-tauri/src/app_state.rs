//! 应用全局状态（Tauri managed state）
//!
//! 替代 lib.rs 顶部的 `static ASR_ENGINE / TTS_ENGINE` 全局变量：
//! 由 `Builder::manage()` 注入，命令通过 `State<AppState>` 访问。

use std::sync::Arc;

use parking_lot::Mutex;

use crate::tts::service::TtsService;

/// 全局引擎句柄
pub struct AppState {
    pub tts: Arc<Mutex<TtsService>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            tts: Arc::new(Mutex::new(TtsService::new())),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
