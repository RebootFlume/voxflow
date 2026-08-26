//! Matcha 真实加载验证：model-steps-3.onnx 支持
//! 需要：matcha-icefall-zh-baker 已下载（含 model-steps-3.onnx）

use std::path::Path;

use voxflow_lib::tts::engine::e2e_registry::E2eTtsModel;
use voxflow_lib::tts::engine::sherpa::SherpaTtsEngine;
use voxflow_lib::tts::traits::TtsEngine;

#[test]
fn matcha_load_with_steps3_onnx() {
    // 定位模型目录
    let model_dir = voxflow_lib::model_manager::model_dir("Matcha-zh-baker");
    eprintln!("[test] model_dir = {}", model_dir.display());
    assert!(model_dir.exists(), "matcha 目录应存在");
    assert!(model_dir.join("model-steps-3.onnx").exists(), "应有 model-steps-3.onnx");
    assert!(model_dir.join("tokens.txt").exists(), "应有 tokens.txt");

    // 引擎加载（detect_model 从目录名识别 Matcha）
    let mut engine = SherpaTtsEngine::new();
    let model_path = model_dir.join("model-steps-3.onnx");
    let result = engine.load(&model_path, "cpu");
    match result {
        Ok(()) => {
            eprintln!("[test] ✅ Matcha 加载成功 (model-steps-3.onnx)");
            assert!(engine.is_loaded());
        }
        Err(e) => {
            eprintln!("[test] ❌ Matcha 加载失败: {}", e);
            panic!("加载失败: {}", e);
        }
    }
    engine.unload();
}
