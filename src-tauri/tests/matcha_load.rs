//! Matcha 真实加载验证：model-steps-3.onnx 支持（描述符驱动的 MainModelFile 解析）
//! 需要：matcha-icefall-zh-baker 已下载（含 model-steps-3.onnx）

use voxflow_lib::tts::registry::TtsRegistry;

#[test]
fn matcha_load_with_steps3_onnx() {
    let model_dir = voxflow_lib::model_manager::model_dir("Matcha-zh-baker");
    eprintln!("[test] model_dir = {}", model_dir.display());
    assert!(model_dir.exists(), "matcha 目录应存在");
    // 官方包主模型名为 model-steps-3.onnx（描述符 RuntimeKey::MainModelFile 负责解析）
    assert!(
        model_dir.join("model-steps-3.onnx").exists(),
        "应有 model-steps-3.onnx"
    );
    assert!(model_dir.join("tokens.txt").exists(), "应有 tokens.txt");

    let registry = TtsRegistry::new();
    match registry.load("Matcha-zh-baker", "cpu") {
        Ok((framework, name)) => {
            eprintln!("[test] ✅ Matcha 加载成功: {name} (framework={framework})");
            assert!(registry.is_loaded());
        }
        Err(e) => panic!("加载失败: {e}"),
    }
    registry.unload().expect("卸载失败");
    assert!(!registry.is_loaded());
}
