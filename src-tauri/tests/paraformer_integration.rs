//! Paraformer-zh-small 集成测试：sherpa 引擎加载 + 转写
//! 需要：模型已下载到 modelRoot/sherpa-onnx-paraformer-zh-small-2024-03-09

use std::path::Path;

#[test]
fn sherpa_asr_paraformer_transcribe() {
    let model = "Paraformer-zh-small";
    let engine = voxflow_lib::inference::sherpa_asr::global_engine();
    let model_dir = voxflow_lib::model_manager::model_dir(model);
    eprintln!("[test] model_dir = {}", model_dir.display());
    assert!(model_dir.join("model.int8.onnx").exists(), "Paraformer 模型未下载");

    // 加载（sherpa_asr 自动识别 Paraformer 参数）
    engine.load(model, "cuda").expect("Paraformer 加载失败");
    eprintln!("[test] loaded: state={:?} model={}", engine.state(), engine.model());

    // 用测试音频转写
    let wav_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../benchmarks/test-audio/tts-short.wav");
    let (samples, rate, _channels) =
        voxflow_lib::audio::wav::read_wav(&wav_path).expect("读取 wav 失败");
    eprintln!("[test] wav samples = {}, rate = {}", samples.len(), rate);

    let text = engine.transcribe(&samples, rate).expect("转写失败");
    eprintln!("[test] Paraformer ASR result: {text}");
    assert!(!text.is_empty(), "转写结果不应为空");

    engine.unload();
    eprintln!("[test] unloaded OK");
}
