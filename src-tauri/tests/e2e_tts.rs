//! Kokoro (sherpa-onnx) E2E TTS 引擎集成测试（TtsRegistry 路由）
//!
//! 前置：models/kokoro-multi-lang-v1_0 + libs/sherpa-onnx 已落地
//! 运行：cargo test --test e2e_tts -- --ignored --nocapture

#[test]
#[ignore]
fn test_kokoro_e2e_synthesize_chinese() {
    use voxflow_lib::tts::registry::TtsRegistry;

    let registry = TtsRegistry::new();
    let dir = voxflow_lib::model_manager::get_model_root().join("kokoro-multi-lang-v1_0");
    if !dir.exists() {
        eprintln!("[skip] Kokoro 模型不存在: {}", dir.display());
        return;
    }

    eprintln!("加载 Kokoro: {}", dir.display());
    let t0 = std::time::Instant::now();
    let (_fw, name) = registry.load("Kokoro-v1_0", "cpu").expect("Kokoro 加载失败");
    let engine = registry.active().expect("引擎未加载");
    eprintln!(
        "加载完成 {:.2}s, 模型: {} (engine={})",
        t0.elapsed().as_secs_f64(),
        name,
        engine.name()
    );
    assert_eq!(engine.name(), "kokoro-multi-lang-v1_0");

    let text = "今天下午三点开会，语音输入法的核心指标是首字延迟。";
    let t1 = std::time::Instant::now();
    let audio = engine.synthesize(text, "45").expect("Kokoro 合成失败");
    eprintln!(
        "中文合成: {} samples @ {}Hz, {:.1}s",
        audio.samples.len(),
        audio.sample_rate,
        t1.elapsed().as_secs_f64()
    );
    assert!(!audio.samples.is_empty());
    assert!(audio.samples.iter().any(|&s| s != 0), "全零（静音）");

    // 中英混说（Kokoro 核心优势）
    let t2 = std::time::Instant::now();
    let audio2 = engine
        .synthesize("手机是 Xiaomi 15 Pro，支持 5G 网络。", "52")
        .expect("Kokoro 中英混说失败");
    eprintln!(
        "中英混说: {} samples, {:.1}s",
        audio2.samples.len(),
        t2.elapsed().as_secs_f64()
    );
    assert!(!audio2.samples.is_empty());

    // 写 WAV 供人工验证（采样率取引擎返回值，不硬编码）
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("kokoro_test_output.wav");
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: audio.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(&out, spec).expect("create wav");
    for &s in &audio.samples {
        w.write_sample(s).expect("write sample");
    }
    w.finalize().expect("finalize wav");
    eprintln!("已保存: {}", out.display());
}

/// Matcha (sherpa-onnx) E2E：中文合成 + 文本正则（数字/日期/电话走 --tts-rule-fsts）
///
/// 前置：models/matcha-icefall-zh-baker + models/vocos-22khz-univ.onnx（vocoder 单独下载）
///        + libs/sherpa-onnx 已落地
/// 运行：cargo test --test e2e_tts -- --ignored --nocapture
///
/// 回归意义：修复前该模型给 CLI 传的是 `--matcha-data-dir=espeak-ng-data`（目录不存在，
/// 且一旦给出就让 sherpa-onnx 忽略 `--matcha-lexicon`）⇒ CLI 直接 `Errors in config!`；
/// 同时缺 `--matcha-vocoder`。本测试用真引擎跑通即守护这个参数集不被改回去。
#[test]
#[ignore]
fn test_matcha_e2e_synthesize_chinese() {
    use voxflow_lib::tts::registry::TtsRegistry;

    let root = voxflow_lib::model_manager::get_model_root();
    let dir = root.join("matcha-icefall-zh-baker");
    let vocoder = root.join("vocos-22khz-univ.onnx");
    if !dir.exists() || !vocoder.exists() {
        eprintln!(
            "[skip] Matcha 模型或 vocoder 不存在: {} / {}",
            dir.display(),
            vocoder.display()
        );
        return;
    }

    let registry = TtsRegistry::new();
    let (_fw, name) = registry.load("Matcha-zh-baker", "cpu").expect("Matcha 加载失败");
    let engine = registry.active().expect("引擎未加载");
    eprintln!("加载完成, 模型: {} (engine={})", name, engine.name());

    // 含数字/日期/电话 ⇒ 同时覆盖 --tts-rule-fsts 是否真的生效（不报错即可合成）
    let text = "今天下午三点开会，电话是 13800138000，日期 2026 年 9 月 20 日。";
    let t = std::time::Instant::now();
    let audio = engine.synthesize(text, "").expect("Matcha 合成失败");
    eprintln!(
        "中文合成: {} samples @ {}Hz, {:.1}s",
        audio.samples.len(),
        audio.sample_rate,
        t.elapsed().as_secs_f64()
    );
    assert!(!audio.samples.is_empty());
    assert!(audio.samples.iter().any(|&s| s != 0), "全零（静音）");

    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("matcha_test_output.wav");
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: audio.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(&out, spec).expect("create wav");
    for &s in &audio.samples {
        w.write_sample(s).expect("write sample");
    }
    w.finalize().expect("finalize wav");
    eprintln!("已保存: {}", out.display());
}
