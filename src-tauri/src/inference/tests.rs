//! Rust 推理引擎对照测试
//! 验证：音频模块输出 vs Python 输出，模型加载是否正常


#[test]
fn test_audio_decode_wav() {
    // 创建测试 WAV 文件
    let tmp = std::env::temp_dir().join("voxflow_test_decode.wav");
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&tmp, spec).unwrap();
    for i in 0..16000 { // 1 秒
        writer.write_sample((i as f32 / 16000.0 * 32767.0) as i16).unwrap();
    }
    writer.finalize().unwrap();

    // Rust 解码
    let data = std::fs::read(&tmp).unwrap();
    let (samples, rate) = crate::audio::decode_audio(&data).unwrap();
    assert_eq!(rate, 16000);
    assert_eq!(samples.len(), 16000);
    // 验证第一个样本接近 0
    assert!(samples[0].abs() < 0.01);
    // 验证最后一个样本接近 1.0
    assert!(samples[15999].abs() > 0.95);

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn test_audio_resample() {
    let samples = vec![0.0; 16000];
    let result = crate::audio::resample_linear(&samples, 16000, 24000);
    assert_eq!(result.len(), 24000);
}

#[test]
fn test_audio_float_int16_roundtrip() {
    let original = vec![0.0f32, 0.5, -0.5, 1.0, -1.0];
    let int16 = crate::audio::float_to_int16(&original);
    let back = crate::audio::int16_to_float(&int16);
    for (a, b) in original.iter().zip(back.iter()) {
        assert!((a - b).abs() < 0.001, "{} != {}", a, b);
    }
}

#[test]
#[ignore = "needs 300MB+ model download; run with --ignored"]
fn test_tts_model_load() {
    let registry = crate::tts::registry::TtsRegistry::new();
    let result = registry.load("Kokoro-v1_0", "cpu");
    assert!(result.is_ok(), "TTS 模型加载失败: {:?}", result.err());
    assert!(registry.is_loaded());
    assert!(!registry.loaded_model().is_empty());
    println!("TTS 模型加载成功: {}", registry.loaded_model());
}

#[test]
#[ignore = "needs model + sherpa-onnx; run with --ignored"]
fn test_tts_inference_pipeline() {
    let registry = crate::tts::registry::TtsRegistry::new();
    registry.load("Kokoro-v1_0", "cpu").unwrap();

    let engine = registry.active().expect("引擎未加载");
    // 中文（端到端直通，须产出实质音频而非报错/空）
    engine.set_language("zh").unwrap();
    let audio = engine.synthesize("你好世界", "45").unwrap();
    assert!(!audio.samples.is_empty());
    println!(
        "TTS 中文推理成功: {} samples @ {}Hz",
        audio.samples.len(),
        audio.sample_rate
    );
}

// ─── registry 路由 / 互斥测试 ──────────────────────────────────────────────

#[test]
fn test_registry_engine_frameworks() {
    let r = crate::inference::registry::registry();

    // 两个框架都注册了
    assert!(r.engine("gguf").is_some());
    assert!(r.engine("onnx").is_some());
    assert!(r.engine("pytorch").is_none(), "PyTorch 尚未注册");

    // adapter 的 framework 标识正确
    assert_eq!(r.engine("gguf").unwrap().framework(), "gguf");
    assert_eq!(r.engine("onnx").unwrap().framework(), "onnx");
}

#[test]
fn test_registry_load_model_not_downloaded() {
    // 未下载模型 → 加载应报错（不 panic），证明路由链路通
    let r = crate::inference::registry::registry();
    let result = r.load_model("gguf", "Nonexistent-Model");
    assert!(result.is_err(), "未知模型应报错，实际: {result:?}");
    let result = r.load_model("onnx", "Nonexistent-Model");
    assert!(result.is_err(), "未知模型应报错，实际: {result:?}");
    let result = r.load_model("pytorch", "Qwen3-TTS");
    assert!(result.is_err(), "未注册框架应报错");
}


/// 长音频（180s）必须**分段**转写：ctx 2048 下单次请求会超过上下文并报 400。
/// 覆盖热键 / HTTP API 现在走的那条路径（真引擎 + 真滑动窗口分段）。
///
/// 手动运行（需本机 0.6B GGUF 模型 + CUDA）：
///   cargo test --lib -- --ignored smoke_long_audio_segmented --nocapture
#[test]
#[ignore = "needs local 0.6B gguf model + CUDA GPU; run with --ignored"]
fn smoke_long_audio_segmented() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let model_dir = manifest.join("../data/models/qwen3-asr-0.6b-gguf");
    let cfg = crate::inference::llama_server::LlamaServerConfig {
        server_path: manifest
            .join("target/debug/libs/llama-cpp")
            .join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" }),
        model_path: model_dir.join("Qwen3-ASR-0.6B-Q8_0.gguf"),
        mmproj_path: model_dir.join("mmproj-Qwen3-ASR-0.6B-Q8_0.gguf"),
        port: 18941,
        n_gpu_layers: 99,
        ctx_size: 2048,
        parallel: 1,
        temperature: 0.0,
        no_webui: true,
        mmproj_offload: true,
    };
    assert!(cfg.model_path.is_file(), "模型缺失: {}", cfg.model_path.display());
    assert!(cfg.mmproj_path.is_file(), "mmproj 缺失: {}", cfg.mmproj_path.display());

    let engine = crate::inference::llama_server::global_engine();
    engine.load_with_config(cfg, &mut |_| {}).expect("llama-server 启动失败");

    // 真实语音铺满 180s（> 3 × 60s 段，触发滑动窗口分段）
    let wav =
        std::fs::read(manifest.join("../benchmarks/test-audio/asr-test-zh.wav")).expect("样本音频");
    let (clip, rate) = crate::audio::decode_audio(&wav).expect("解码样本");
    assert!(!clip.is_empty(), "样本音频为空");
    let mut samples: Vec<f32> = Vec::new();
    while samples.len() < rate as usize * 180 {
        samples.extend_from_slice(&clip);
    }
    samples.truncate(rate as usize * 180);

    let adapter = crate::inference::llama_server::LlamaAsrAdapter::new();
    let text = crate::inference::transcribe_chunks::transcribe_long(
        &adapter,
        &samples,
        rate,
        &mut |_, _| {},
    )
    .expect("180s 必须转写成功（分段）；单次请求会在 ctx 2048 下报 400");
    println!(
        "[smoke] 180s → {} 字: {}",
        text.chars().count(),
        text.chars().take(50).collect::<String>()
    );
    assert!(text.chars().count() > 20, "长音频应产出非空文本: {text:?}");

    engine.unload().ok();
}
