//! Rust 侧 `log::` 记录 → 前端运行日志桥（status: "rust_log" 事件）
//!
//! 背景：引擎层的 log::info!/warn!（llama_server 端口守卫/身份验证、sherpa 加载等）
//! 此前无人安装 logger，全部静默丢弃 —— "都接日志" 需要它们也出现在用户可见的运行日志里。
//!
//! 设计：
//! - 只桥接本项目 crate（target 前缀 "voxflow"）的 info/warn/error 记录，
//!   过滤 hyper/reqwest/tauri 等三方噪音；
//! - logger 通过 mpsc 交给独立线程，由线程 app.emit("sidecar://event", rust_log)，
//!   避免在任意线程直接触碰 Tauri 事件；
//! - 早期（emitter 尚未启动）的记录丢弃即可（引擎事件本身已带完整流程信息）。

use log::{Level, LevelFilter, Log, Metadata, Record};
use std::sync::OnceLock;
use tauri::Emitter;

static TX: OnceLock<std::sync::mpsc::Sender<String>> = OnceLock::new();

struct BridgeLogger;

impl Log for BridgeLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= Level::Info
    }

    fn log(&self, record: &Record<'_>) {
        // 只桥接本项目记录（voxflow_lib / voxflow 的模块路径）
        if !record.target().starts_with("voxflow") {
            return;
        }
        let msg = record.args().to_string();
        if msg.is_empty() {
            return;
        }
        let level = match record.level() {
            Level::Error => "error",
            Level::Warn => "warn",
            Level::Info => "info",
            Level::Debug | Level::Trace => "info",
        };
        // dev 控制台也保留一份
        eprintln!("[{level}] {}", msg);
        if let Some(tx) = TX.get() {
            let line = serde_json::json!({ "level": level, "msg": msg, "target": record.target() });
            let _ = tx.send(line.to_string());
        }
    }

    fn flush(&self) {}
}

/// 安装桥接 logger（幂等：已安装则跳过）
pub fn install() {
    if TX.get().is_some() {
        return;
    }
    let _ = log::set_boxed_logger(Box::new(BridgeLogger));
    log::set_max_level(LevelFilter::Info);
}

/// 启动事件发射线程（需 AppHandle；在 setup 中调用）
pub fn start_emitter(app: tauri::AppHandle) {
    if TX.get().is_some() {
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let _ = TX.set(tx);
    std::thread::Builder::new()
        .name("rust-log-bridge".into())
        .spawn(move || {
            while let Ok(line) = rx.recv() {
                let v: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
                let _ = app.emit(
                    "sidecar://event",
                    serde_json::json!({
                        "status": "rust_log",
                        "level": v.get("level").and_then(|x| x.as_str()).unwrap_or("info"),
                        "msg": v.get("msg").and_then(|x| x.as_str()).unwrap_or(""),
                        "target": v.get("target").and_then(|x| x.as_str()).unwrap_or(""),
                    }),
                );
            }
        })
        .ok();
}
