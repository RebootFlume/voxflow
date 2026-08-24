//! TTS 调试：对比 espeak-ng bundle 前后的音频质量
//! 用法：cargo run --example tts_debug --release

use std::path::Path;

use voxflow_lib::tts::config::ModelManifest;
use voxflow_lib::tts::engine::onnx::GenericOnnxEngine;
use voxflow_lib::tts::middleware::PhonemizerRouter;
use voxflow_lib::tts::service::TtsService;
use voxflow_lib::tts::traits::TtsEngine;

fn save_wav(path: &str, samples: &[i16]) {
    let spec = hound::WavSpec { channels: 1, sample_rate: 24000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for &s in samples { w.write_sample(s).unwrap(); }
    w.finalize().unwrap();
    println!("saved {} ({} samples)", path, samples.len());
}
fn to_i16(v: &[f32]) -> Vec<i16> {
    v.iter().map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16).collect()
}
fn rms_f32(v: &[f32]) -> f64 {
    (v.iter().map(|s| s * s).sum::<f32>() / v.len() as f32).sqrt() as f64
}

fn main() {
    let model_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../models/Kokoro-82M/onnx/model.onnx");
    let root = ModelManifest::resolve_model_root(&model_path);
    let manifest = ModelManifest::load(&root).unwrap();
    println!("manifest id={} pipeline={:?}", manifest.id, manifest.pipeline_type);

    // ── tokenizer vocab ──
    let tok = serde_json::from_str::<serde_json::Value>(
        &std::fs::read_to_string(root.join("tokenizer.json")).unwrap()).unwrap();
    let mut vocab = std::collections::HashMap::new();
    for (k, v) in tok["model"]["vocab"].as_object().unwrap() {
        if let Some(id) = v.as_u64() { vocab.insert(k.clone(), id as u32); }
    }

    // ── router：现在能找到捆绑的 espeak-ng → proper IPA ──
    let router = PhonemizerRouter::new();
    let phonemes: Vec<String> = router.phonemize("Hello world");
    let espeak_ids = router.to_token_ids("Hello world", &vocab);
    println!("espeak phonemes : {:?}", phonemes);
    println!("espeak token_ids: {:?}", espeak_ids);

    // ── 手动正确英文 IPA（top-line reference） ──
    let ipa_ids: Vec<i64> = ["$","h","ə","l","o","ʊ","w","ɜ","ː","l","d","$"]
        .iter().map(|c| vocab[*c] as i64).collect();
    println!("manual IPA ids  : {:?}", ipa_ids);

    // ── voice table ──
    let voice_data = std::fs::read(root.join("voices/af.bin")).unwrap();
    let vt: Vec<f32> = voice_data.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    assert_eq!(vt.len(), 512 * 256);
    let row = (espeak_ids.len().max(ipa_ids.len()).max(20)).min(511);
    let style: Vec<f32> = vt[row * 256..row * 256 + 256].to_vec();
    println!("voice row={row}");

    let session = ort::session::Session::builder().unwrap().commit_from_file(&model_path).unwrap();
    let mut engine = GenericOnnxEngine::new(session, manifest.clone());

    // ① 修复前（service baseline — old letter phonemes）
    let mut svc = TtsService::new();
    svc.load(&model_path, "cpu").unwrap();
    let samples_baseline = svc.infer("Hello world", "af", 1.0).unwrap();
    save_wav("tts_baseline_before.wav", &samples_baseline);

    // ② 修复后：espeak proper IPA
    let mut tok_es = espeak_ids;
    if tok_es.len() % 2 != 0 { tok_es.push(0); }
    let a_es = engine.run(&tok_es, Some(&style), Some(1.0)).unwrap();
    save_wav("tts_after_espeak_ipa.wav", &to_i16(&a_es));

    // ③ 手动 IPA（top-line reference）
    let mut tok_ipa = ipa_ids;
    if tok_ipa.len() % 2 != 0 { tok_ipa.push(0); }
    let a_ipa = engine.run(&tok_ipa, Some(&style), Some(1.0)).unwrap();
    save_wav("tts_manual_ipa_ref.wav", &to_i16(&a_ipa));

    println!();
    println!("baseline   : len={} rms={:.4}", samples_baseline.len(),
             samples_baseline.iter().map(|&s| (s as f64 / 32767.0)).sum::<f64>() / samples_baseline.len() as f64);
    println!("espeak IPA : len={} rms={:.4}", a_es.len(), rms_f32(&a_es));
    println!("manual IPA : len={} rms={:.4}", a_ipa.len(), rms_f32(&a_ipa));
}
