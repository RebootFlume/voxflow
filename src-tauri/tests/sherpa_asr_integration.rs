//! sherpa ASR 引擎集成测试：真实子进程 + WebSocket 转写
//! 需要：SenseVoice 模型已下载到 modelRoot/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17

use std::path::Path;

#[test]
fn sherpa_asr_transcribe_sensevoice() {
    let model = "SenseVoice-int8";
    let engine = voxflow_lib::inference::sherpa_asr::global_engine();
    let model_dir = voxflow_lib::model_manager::model_dir(model);
    eprintln!("[test] model_dir = {}", model_dir.display());
    assert!(model_dir.join("model.int8.onnx").exists(), "SenseVoice 模型未下载");

    // 加载（启动 websocket server 子进程）
    engine.load(model, "cuda").expect("sherpa ASR 加载失败");
    eprintln!("[test] loaded: state={:?} model={}", engine.state(), engine.model());

    // 用测试音频转写（8k → 引擎内部重采样到 16k）
    let wav_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../benchmarks/test-audio/tts-short.wav");
    let (samples, rate, _channels) =
        voxflow_lib::audio::wav::read_wav(&wav_path).expect("读取 wav 失败");
    eprintln!("[test] wav samples = {}, rate = {}", samples.len(), rate);

    let text = engine.transcribe(&samples, rate).expect("转写失败");
    eprintln!("[test] ASR result: {text}");
    assert!(!text.is_empty(), "转写结果不应为空");
    assert!(text.contains("今天") || text.contains("下午") || text.contains("开会"), "结果应含中文: {text}");

    engine.unload();
    eprintln!("[test] unloaded OK");
}
