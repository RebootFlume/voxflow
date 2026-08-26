//! 测试 TTS 模型加载和推理（统一 TtsService）

#[test]
fn test_tts_model_load_and_infer() {
    use std::path::Path;
    use voxflow_lib::tts::traits::TtsEngine;

    let model_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../models/kokoro-multi-lang-v1_0/model.onnx");

    if !model_path.exists() {
        eprintln!("Model not found: {:?}", model_path);
        return;
    }

    eprintln!("Loading model: {:?}", model_path);

    // 创建 TTS 服务（配置驱动的统一引擎）
    let mut service = voxflow_lib::tts::service::TtsService::new();

    // 加载模型（Kokoro E2E → sherpa-onnx 子进程）
    let result = service.load(&model_path, "cpu");

    match result {
        Ok(()) => {
            eprintln!("✓ Model loaded successfully");
            eprintln!("  Model name: {}", service.name());
            eprintln!("  Is loaded: {}", service.is_loaded());

            // 测试推理（中文，端到端直通）
            match service.infer("今天下午三点开会", "45") {
                Ok(samples) => {
                    eprintln!("✓ Inference successful");
                    eprintln!("  Output samples: {}", samples.len());
                    eprintln!("  Sample rate: 24000 Hz");
                    eprintln!("  Duration: {:.2}s", samples.len() as f64 / 24000.0);
                    assert!(!samples.is_empty(), "合成音频不应为空");
                }
                Err(e) => {
                    eprintln!("✗ Inference failed: {e}");
                    panic!("TTS 推理失败: {e}");
                }
            }
        }
        Err(e) => {
            eprintln!("✗ Model load failed: {e}");
            panic!("TTS 模型加载失败: {e}");
        }
    }
}
