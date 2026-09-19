//! 框架可用性验收：一次安装 → ASR 与 TTS 两个工具都可解析、校验通过
//!
//! 覆盖：
//! - 布局单一真源：`runtime_paths::sherpa_exe` 与下载 marker / 两个引擎一致（bin/ 下）
//! - 完整性校验把 TTS exe 也算入 → `ready` 蕴含"两个工具都在"
//! - 两步校验（文件检查 + 试启动）在本机运行时上真跑通过
//!
//! 前置：libs/sherpa-onnx 已就位（bin/ 布局）。缺失时打印跳过（CI 无运行时环境）。

use voxflow_lib::inference::runtime_paths;

fn models_has_sherpa() -> bool {
    runtime_paths::sherpa_runtime_dir().exists()
}

#[test]
fn test_sherpa_layout_single_source_covers_both_tools() {
    if !models_has_sherpa() {
        eprintln!("[skip] 未安装 sherpa 运行时");
        return;
    }
    // 规范布局 = <sherpa_runtime_dir>/bin/…，ASR 与 TTS 共用同一解析
    let ws = runtime_paths::sherpa_exe("sherpa-onnx-offline-websocket-server.exe");
    let tts = runtime_paths::sherpa_exe("sherpa-onnx-offline-tts.exe");
    eprintln!("[runtime] ws={}", ws.display());
    eprintln!("[runtime] tts={}", tts.display());
    assert!(ws.exists(), "ASR websocket server 应可解析: {}", ws.display());
    assert!(tts.exists(), "TTS 工具应可解析（一次安装两个都可用）: {}", tts.display());
}

#[test]
fn test_sherpa_runtime_verify_reports_ready() {
    if !models_has_sherpa() {
        eprintln!("[skip] 未安装 sherpa 运行时");
        return;
    }
    // 两步校验：① 文件检查（含 TTS exe + 13 个 CUDA 库）② 试启动（DLL 链可跑）
    let r = voxflow_lib::inference::runtime_download::verify_runtime_full("onnx");
    eprintln!("[verify] {r}");
    assert_eq!(r["state"], "ready", "校验应为 ready，实际: {r}");
    assert_eq!(r["installed"], true);
}
