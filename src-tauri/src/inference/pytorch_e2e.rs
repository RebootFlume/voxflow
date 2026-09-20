//! PyTorch 端到端验证：模型描述符 → 注册表路由 → adapter → worker 子进程 → 真实推理。
//!
//! 需要三个前提，缺一即自动跳过（CI / 干净机器不会红）：
//! 1. PyTorch 运行时已安装（`libs/pytorch-cpu` 或 `libs/pytorch-cuda130`，含适配器依赖）；
//! 2. 模型已下载（`data/models/whisper-tiny-pt`、`data/models/kokoro-82m-pt`）；
//! 3. 测试音频 `benchmarks/test-audio/asr-test-16k.wav`。
//!
//! 手动运行：`cargo test --lib pytorch_e2e -- --nocapture`

use std::path::PathBuf;

use crate::inference::engine::AsrEngine;

fn runtime_installed() -> bool {
    crate::inference::runtime_download::installed_runtime_for_device("pytorch", "cpu").is_some()
}

fn model_dir(id: &str) -> PathBuf {
    crate::model_manager::get_model_root().join(id)
}

fn test_audio() -> Option<Vec<f32>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../benchmarks/test-audio/asr-test-16k.wav");
    let mut reader = hound::WavReader::open(path).ok()?;
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, 16000, "测试音频必须是 16k");
    Some(
        reader
            .samples::<i16>()
            .map(|s| s.unwrap() as f32 / 32768.0)
            .collect(),
    )
}

/// ASR 链路：描述符 → PyTorchAsrAdapter → worker → Whisper 转写
///
/// 刻意**不用全局注册表**：`inference::registry()` 是进程级单例，套件并行跑时
/// 其它用例的 load 会按互斥规则卸载本用例的引擎（实测踩到过）。注册表路由已由
/// `inference::tests` 的确定性用例覆盖，这里只验"适配器 + worker + 真实模型"。
#[test]
fn test_pytorch_e2e_asr_transcribe() {
    if !runtime_installed() {
        eprintln!("SKIP: 未安装 PyTorch CPU 运行时");
        return;
    }
    if !model_dir("whisper-tiny-pt").join("model.safetensors").is_file() {
        eprintln!("SKIP: 未下载 whisper-tiny-pt 模型");
        return;
    }
    let Some(samples) = test_audio() else {
        eprintln!("SKIP: 缺少测试音频");
        return;
    };
    let adapter = crate::inference::pytorch_asr::PyTorchAsrAdapter::new();
    assert_eq!(adapter.framework(), "pytorch");
    assert_eq!(adapter.current_model(), "");
    assert!(!adapter.is_loaded());

    let mut stages: Vec<String> = Vec::new();
    adapter
        .load_model_with_stage_and_device("Whisper-tiny-PT", "cpu", &mut |s| stages.push(s.to_string()))
        .expect("PyTorch ASR 加载应成功");
    assert!(stages.iter().any(|s| s == "loading"), "阶段回调应上报 loading: {stages:?}");
    assert!(stages.last().is_some_and(|s| s == "ready"));
    assert!(adapter.is_loaded());
    assert_eq!(adapter.current_model(), "Whisper-tiny-PT");
    assert!(adapter.pid().is_some(), "worker 子进程应有 PID");
    assert_eq!(adapter.vram_estimate_mb(), None, "CPU 模式不应报显存占用");

    let text = adapter.transcribe(&samples, 16000).expect("转写应成功");
    eprintln!("[e2e] whisper-tiny 转写: {text:?}");
    assert!(!text.trim().is_empty(), "转写结果不应为空");
    // 上下文接口走同一条 worker 命令（Whisper prompt_ids）
    let with_ctx = adapter
        .transcribe_with_context(&samples, 16000, "今天下午三点我们开会")
        .expect("带上文转写应成功");
    assert!(!with_ctx.trim().is_empty());

    // 幂等：同模型同设备重复加载不应重启进程
    let pid_before = adapter.pid();
    adapter
        .load_model_with_device("Whisper-tiny-PT", "cpu")
        .expect("重复加载应成功");
    assert_eq!(adapter.pid(), pid_before, "幂等加载不应换进程");

    adapter.unload().expect("卸载应成功");
    assert!(!adapter.is_loaded());
    assert_eq!(adapter.current_model(), "");
    assert!(adapter.pid().is_none(), "卸载后 worker 进程应已回收");
}

/// TTS 链路：描述符 → TtsRegistry → PyTorchTtsEngine → worker → Kokoro 合成
#[test]
fn test_pytorch_e2e_tts_synthesize() {
    if !runtime_installed() {
        eprintln!("SKIP: 未安装 PyTorch CPU 运行时");
        return;
    }
    if !model_dir("kokoro-82m-pt").join("kokoro-v1_0.pth").is_file() {
        eprintln!("SKIP: 未下载 kokoro-82m-pt 模型");
        return;
    }
    let registry = crate::tts::registry::TtsRegistry::new();
    let (framework, model) = registry
        .load("Kokoro-82M-PT", "cpu")
        .expect("PyTorch TTS 加载应成功");
    assert_eq!(framework, "pytorch");
    assert_eq!(model, "Kokoro-82M-PT");
    assert!(registry.is_loaded());
    assert_eq!(registry.loaded_model(), "kokoro-82m-pt");

    let audio = registry
        .active()
        .expect("应有活动引擎")
        .synthesize("今天下午三点我们开会讨论项目进度。", "")
        .expect("合成应成功");
    assert_eq!(audio.sample_rate, 24000, "Kokoro 输出应为 24k");
    assert!(audio.samples.len() > 24000, "5 秒级语音样本数应大于 1 秒: {}", audio.samples.len());
    let peak = audio.samples.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
    assert!(peak > 1000, "合成音频不应近乎静音（峰值 {peak}）");
    eprintln!("[e2e] kokoro 合成 {} 样本 @{}Hz 峰值 {peak}", audio.samples.len(), audio.sample_rate);

    // 语言门禁：单语模型必须明确拒绝其它语言，而不是静默合成
    let engine = registry.active().expect("应有活动引擎");
    assert!(engine.set_language("zh").is_ok());
    assert!(engine.set_language("en").is_err(), "Kokoro 不应接受不支持的语言");

    registry.unload().expect("卸载应成功");
    assert!(!registry.is_loaded());
}

/// 未安装运行时时的可读失败（不做任何兜底猜测）
#[test]
fn test_pytorch_load_without_runtime_reports_actionable_error() {
    if runtime_installed() {
        eprintln!("SKIP: 本机已安装运行时，无法验证缺失分支");
        return;
    }
    let registry = crate::inference::registry::registry();
    let err = registry
        .load_asr_by_name("Whisper-tiny-PT", "cpu", &mut |_| {})
        .unwrap_err();
    assert!(err.contains("未安装"), "错误应指明运行时未安装: {err}");
}
