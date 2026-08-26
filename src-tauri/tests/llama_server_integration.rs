//! llama-server 子进程 + HTTP 集成测试
//!
//! 前置条件（与 benchmarks/BENCHMARK-RESULTS.md 一致）：
//!   benchmarks/llama-cpp/llama-server.exe
//!   benchmarks/llama-cpp/Qwen3-ASR-0.6B-Q8_0.gguf
//!   benchmarks/llama-cpp/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf
//!   benchmarks/test-audio/tts-short.wav （或任意 16k wav）
//!
//! 运行：cargo test --test llama_server_integration -- --ignored --nocapture

use std::path::PathBuf;

use voxflow_lib::inference::llama_server::{init_global, LlamaServerConfig};

/// 构建测试配置（指向 benchmarks 目录）
fn test_config() -> LlamaServerConfig {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("benchmarks")
        .join("llama-cpp");
    LlamaServerConfig {
        server_path: root.join("llama-server.exe"),
        model_path: root.join("Qwen3-ASR-0.6B-Q8_0.gguf"),
        mmproj_path: root.join("mmproj-Qwen3-ASR-0.6B-Q8_0.gguf"),
        port: 8931,
        n_gpu_layers: 99,
        ctx_size: 8192,
        parallel: 1,
        no_webui: true,
    }
}

#[test]
#[ignore] // 需要 GPU + 模型文件，CI 不跑
fn test_llama_server_transcribe_short() {
    // 1. 初始化全局引擎（自定义配置）
    let engine = voxflow_lib::inference::llama_server::init_global(test_config());

    // 2. 加载（启动子进程 + 健康检查）
    engine.load().expect("启动 llama-server 失败");

    // 3. 读取测试音频（16k float32）
    let wav_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("benchmarks/test-audio/tts-short.wav");
    if !wav_path.exists() {
        eprintln!("[skip] 测试音频不存在: {}", wav_path.display());
        return;
    }
    let data = std::fs::read(&wav_path).unwrap();
    let (samples, sample_rate) = voxflow_lib::audio::decode_audio(&data).unwrap();
    eprintln!(
        "音频: {} samples @ {}Hz ({:.2}s)",
        samples.len(),
        sample_rate,
        samples.len() as f64 / sample_rate as f64
    );

    // 4. 转写（计时）
    let start = std::time::Instant::now();
    let text = engine.transcribe(&samples, sample_rate).unwrap();
    let elapsed = start.elapsed();
    eprintln!("识别结果: {}", text);
    eprintln!("耗时: {:.1} ms", elapsed.as_millis());

    // 5. 断言非空
    assert!(!text.trim().is_empty(), "识别结果为空");

    // 6. 卸载
    engine.unload().unwrap();
}

#[test]
#[ignore]
fn test_llama_server_load_unload_idempotent() {
    let engine = voxflow_lib::inference::llama_server::init_global(test_config());

    // 重复加载应幂等（已加载则直接返回）
    engine.load().expect("第一次加载失败");
    let first = engine.is_loaded();
    engine.load().expect("第二次加载失败");
    assert!(engine.is_loaded());

    engine.unload().expect("卸载失败");
    assert!(!engine.is_loaded());
    eprintln!("is_loaded(first)={first}, after unload=false ✓");
}
