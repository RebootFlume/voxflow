//! Kokoro (sherpa-onnx) E2E TTS 引擎集成测试
//!
//! 前置：models/kokoro-multi-lang-v1_0 + libs/sherpa-onnx 已落地
//! 运行：cargo test --test e2e_tts -- --ignored --nocapture

use voxflow_lib::tts::traits::TtsEngine;

fn models_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("models")
}

#[test]
#[ignore]
fn test_kokoro_e2e_synthesize_chinese() {
    let mut service = voxflow_lib::tts::service::TtsService::new();
    let model_path = models_root().join("kokoro-multi-lang-v1_0/model.onnx");
    if !model_path.exists() {
        eprintln!("[skip] Kokoro 模型不存在: {}", model_path.display());
        return;
    }

    eprintln!("加载 Kokoro: {}", model_path.display());
    let t0 = std::time::Instant::now();
    service.load(&model_path, "cpu").expect("Kokoro 加载失败");
    eprintln!("加载完成 {:.2}s, 模型: {}", t0.elapsed().as_secs_f64(), service.name());
    assert_eq!(service.name(), "kokoro-v1_0");

    let text = "今天下午三点开会，语音输入法的核心指标是首字延迟。";
    let t1 = std::time::Instant::now();
    let samples = service.infer(text, "45").expect("Kokoro 合成失败");
    eprintln!("中文合成: {} samples, {:.1}s", samples.len(), t1.elapsed().as_secs_f64());
    assert!(!samples.is_empty());
    assert!(samples.iter().any(|&s| s != 0), "全零（静音）");

    // 中英混说（Kokoro 核心优势）
    let t2 = std::time::Instant::now();
    let samples2 = service
        .infer("手机是 Xiaomi 15 Pro，支持 5G 网络。", "52")
        .expect("Kokoro 中英混说失败");
    eprintln!("中英混说: {} samples, {:.1}s", samples2.len(), t2.elapsed().as_secs_f64());
    assert!(!samples2.is_empty());

    // 写 WAV 供人工验证
    let out = models_root().parent().unwrap().join("kokoro_test_output.wav");
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 24000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(&out, spec).expect("create wav");
    for &s in &samples {
        w.write_sample(s).expect("write sample");
    }
    w.finalize().expect("finalize wav");
    eprintln!("已保存: {}", out.display());
}
