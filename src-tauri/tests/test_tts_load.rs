//! 测试 TTS 模型加载和推理（TtsRegistry 统一路由）

#[test]
fn test_tts_model_load_and_infer() {
    use voxflow_lib::tts::registry::TtsRegistry;

    let registry = TtsRegistry::new();

    // 模型目录不存在时跳过（CI 无模型环境）
    let dir = voxflow_lib::model_manager::get_model_root().join("kokoro-multi-lang-v1_0");
    if !dir.exists() {
        eprintln!("Model not found: {}", dir.display());
        return;
    }

    // 加载（展示名 → 描述符查找 → sherpa 引擎）
    match registry.load("Kokoro-v1_0", "cpu") {
        Ok((framework, name)) => {
            eprintln!("✓ Model loaded: {name} (framework={framework})");
            assert!(registry.is_loaded());

            let engine = registry.active().expect("引擎未加载");
            match engine.synthesize("今天下午三点开会", "45") {
                Ok(audio) => {
                    eprintln!(
                        "✓ Inference: {} samples @ {}Hz",
                        audio.samples.len(),
                        audio.sample_rate
                    );
                    assert!(!audio.samples.is_empty(), "合成音频不应为空");
                    assert!(audio.sample_rate > 0, "采样率应由引擎声明");
                }
                Err(e) => panic!("TTS 推理失败: {e}"),
            }
        }
        Err(e) => panic!("TTS 模型加载失败: {e}"),
    }
}
