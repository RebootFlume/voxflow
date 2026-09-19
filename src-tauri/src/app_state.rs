//! 应用全局状态（Tauri managed state）
//!
//! 由 `Builder::manage()` 注入，命令通过 `State<AppState>` 访问。
//! P2：`Arc<Mutex<TtsService>>` → `Arc<Mutex<TtsRegistry>>`（注册表内部持引擎，
//! Mutex 保留 API server 的 try_lock 忙碌语义——UI 合成期间 HTTP 合成返回 503）。

use std::sync::Arc;

use parking_lot::Mutex;

use crate::tts::registry::TtsRegistry;

/// 全局引擎句柄
pub struct AppState {
    pub tts: Arc<Mutex<TtsRegistry>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            tts: Arc::new(Mutex::new(TtsRegistry::new())),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
