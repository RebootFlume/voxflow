//! Sidecar 兼容层（Python sidecar 已移除）
//!
//! 迁移到 Rust 原生引擎后，这里只保留唯一职责：GPU 检测（供 get_gpu_info）。
//! 其余 Python sidecar 管理代码（进程拉起 / 事件桥接 / 剪贴板上屏）已移除。

use std::process::Command;

use serde_json::Value;

/// Rust 直接检测 GPU：调 nvidia-smi（<100ms，零依赖）
pub fn detect_gpu() -> Value {
    let output = Command::new("nvidia-smi")
        .args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let lines = String::from_utf8_lossy(&o.stdout);
            if let Some(first) = lines.lines().next() {
                let parts: Vec<&str> = first.split(',').map(|s| s.trim()).collect();
                let name = parts.first().unwrap_or(&"");
                let mem: u32 = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
                serde_json::json!({
                    "available": true,
                    "gpuName": name,
                    "memoryMB": mem,
                    "source": "nvidia-smi"
                })
            } else {
                serde_json::json!({"available": false, "gpuName": "", "memoryMB": 0, "source": "nvidia-smi"})
            }
        }
        _ => serde_json::json!({"available": false, "gpuName": "", "memoryMB": 0, "source": "nvidia-smi"})
    }
}
