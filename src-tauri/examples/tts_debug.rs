//! TTS 端到端调试：纯文本 → 端到端模型推理 → WAV
//! 用法：cargo run --example tts_debug --release

use std::path::Path;

use voxflow_lib::tts::config::ModelManifest;
use voxflow_lib::tts::service::TtsService;
use voxflow_lib::tts::traits::TtsEngine;

fn save_wav(path: &str, samples: &[i16]) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 24000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for &s in samples {
        w.write_sample(s).unwrap();
    }
    w.finalize().unwrap();
    println!("saved {} ({} samples)", path, samples.len());
}

fn main() {
    let model_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../models/Kokoro-82M/onnx/model.onnx");
    let root = ModelManifest::resolve_model_root(&model_path);
    let manifest = ModelManifest::load(&root).unwrap();
    println!("manifest id={}", manifest.id);

    // ── E2E 统一调度：纯文本 → 波形 ──
    let mut svc = TtsService::new();
    svc.load(&model_path, "cpu").unwrap();
    println!("model loaded: {} (loaded={})", svc.name(), svc.is_loaded());

    let samples = svc.infer("Hello world", "af").unwrap();
    println!("synthesized {} samples @24kHz ({:.2}s)", samples.len(), samples.len() as f64 / 24000.0);
    save_wav("tts_e2e_output.wav", &samples);
}
