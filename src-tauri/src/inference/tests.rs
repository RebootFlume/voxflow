//! Rust 推理引擎对照测试
//! 验证：音频模块输出 vs Python 输出，模型加载是否正常

use crate::inference::engine::InferenceEngine;
use crate::tts::traits::TtsEngine;

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
    let model_path = crate::model_manager::model_dir("Kokoro-v1_0")
        .join("model.onnx");
    if !model_path.exists() {
        eprintln!("Kokoro ONNX 模型未下载，跳过 TTS 加载测试");
        return;
    }

    let mut service = crate::tts::service::TtsService::new();
    let result = service.load(&model_path, "cpu");
    assert!(result.is_ok(), "TTS 模型加载失败: {:?}", result.err());
    assert!(service.is_loaded());
    assert!(!service.name().is_empty());
    println!("TTS 模型加载成功: {}", service.name());
}

#[test]
#[ignore = "needs model + sherpa-onnx; run with --ignored"]
fn test_tts_inference_pipeline() {
    let model_path = crate::model_manager::model_dir("Kokoro-v1_0")
        .join("model.onnx");
    if !model_path.exists() {
        eprintln!("Kokoro ONNX 模型未下载，跳过 TTS 推理测试");
        return;
    }

    let mut service = crate::tts::service::TtsService::new();
    service.load(&model_path, "cpu").unwrap();

    // 中文（端到端直通，须产出实质音频而非报错/空）
    service.set_language("zh").unwrap();
    let zh_samples = service.infer("你好世界", "zf_xiaobei").unwrap();
    assert!(!zh_samples.is_empty());
    println!("TTS 中文推理成功: {} samples, 24kHz", zh_samples.len());
}

