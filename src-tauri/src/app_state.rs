//! 应用全局状态（Tauri managed state）
//!
//! 由 `Builder::manage()` 注入，命令通过 `State<AppState>` 访问。
//! P2：`Arc<Mutex<TtsService>>` → `Arc<Mutex<TtsRegistry>>`（注册表内部持引擎，
//! Mutex 保留 API server 的 try_lock 忙碌语义——UI 合成期间 HTTP 合成返回 503）。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;

use crate::tts::registry::TtsRegistry;

/// 合成取消令牌（分段边界生效）
///
/// 引擎的一次 `synthesize` 是不可中断的子进程调用（`Command::output()`，不保留 Child
/// 句柄），所以取消只能在**段与段之间**生效：`synthesize_blocking` 每段开始前查一次。
/// 因此 `begin`/`end` 由合成方调用，`request` 只在确有合成在跑时置位，
/// 避免"上一次的取消"误伤下一次合成（用户点取消 → 合成刚好结束 → 再点合成 的场景）。
#[derive(Default)]
pub struct TtsCancel {
    running: AtomicBool,
    cancel: AtomicBool,
}

impl TtsCancel {
    /// 合成开始：清掉历史取消标记并置为运行中
    pub fn begin(&self) {
        self.cancel.store(false, Ordering::SeqCst);
        self.running.store(true, Ordering::SeqCst);
    }

    /// 合成结束（正常 / 失败 / 被取消）
    pub fn end(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.cancel.store(false, Ordering::SeqCst);
    }

    /// 是否已被请求取消（段循环每段查一次）
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// 请求取消；返回是否确有正在进行的合成
    pub fn request(&self) -> bool {
        if !self.running.load(Ordering::SeqCst) {
            return false;
        }
        self.cancel.store(true, Ordering::SeqCst);
        true
    }
}

/// 全局引擎句柄
pub struct AppState {
    pub tts: Arc<Mutex<TtsRegistry>>,
    /// 当前合成的取消令牌（命令层与 `rust_cancel_tts` 共用）
    pub tts_cancel: Arc<TtsCancel>,
    /// 关闭窗口时"隐藏到托盘"（true，默认 = 历史行为）还是"直接退出"（false）。
    /// 由前端设置项同步（`useWindowBehaviorSync`），关窗事件在 `lib.rs` 的 setup 里读它。
    pub close_to_tray: AtomicBool,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            tts: Arc::new(Mutex::new(TtsRegistry::new())),
            tts_cancel: Arc::new(TtsCancel::default()),
            close_to_tray: AtomicBool::new(true),
        }
    }

    /// 设置关窗行为（true = 隐藏到托盘）
    pub fn set_close_to_tray(&self, value: bool) {
        self.close_to_tray.store(value, Ordering::SeqCst);
    }

    /// 关窗时是否隐藏到托盘
    pub fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::SeqCst)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
