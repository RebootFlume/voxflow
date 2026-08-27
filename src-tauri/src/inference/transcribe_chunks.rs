//! 长音频分批转写编排（框架无关，任何 AsrEngine 都受益）
//!
//! ## 为什么需要
//! llama-server 的 context 有限（8192 token），一次性发送长音频会 400 错误。
//! sherpa-onnx 虽支持流式任意长度，但为统一各框架能力，长音频一律走本模块分段。
//!
//! ## 算法（参照 CapsWriter 滑动窗口）
//! 段长 60s + 重叠 4s：
//!   - 每段实际发送 64s（60s 正片 + 4s 重叠尾巴）
//!   - 窗口每次前移 60s，相邻段有 4s 重叠，防止句子被切碎
//!   - 剩余不足 64s 的残留作为最后一段
//!   - 60s ≈ 6000 token < 8192 ctx ✅（llama-server 单段安全）
//!
//! ## 框架无关
//! 只依赖 `AsrEngine::transcribe(&[f32], rate)`，llama-server / sherpa / PyTorch
//! 未来接入零成本获得长音频能力。引擎永远只处理 ≤64s 的一段。

use super::engine::AsrEngine;

/// 段长（秒）：CapsWriter 同款，60s ≈ 6000 token < 8192 ctx
pub const SEG_DURATION_SEC: usize = 60;
/// 重叠（秒）：防止句子被段边界切断
pub const SEG_OVERLAP_SEC: usize = 4;

/// 单段最大长度超过此值才需要分段（短音频直接单次转写，零开销）
pub const CHUNK_THRESHOLD_SEC: usize = SEG_DURATION_SEC;

/// 进度回调：每段完成后触发（done_sec: 已转写秒数, total_sec: 总秒数）
pub type ProgressFn<'a> = &'a mut dyn FnMut(f64, f64);

/// 分批转写长音频
///
/// 返回完整拼接文本。音频 ≤60s 直接单次转写（无分段开销）。
pub fn transcribe_long(
    engine: &dyn AsrEngine,
    samples: &[f32],
    sample_rate: u32,
    on_progress: ProgressFn,
) -> Result<String, String> {
    let total_sec = samples.len() as f64 / sample_rate as f64;

    // 短音频：单次转写，免分段
    if samples.len() <= SEG_DURATION_SEC * sample_rate as usize {
        let text = engine.transcribe(samples, sample_rate)?;
        on_progress(total_sec, total_sec);
        return Ok(text);
    }

    let seg_len = SEG_DURATION_SEC * sample_rate as usize;   // 段长（样本数）
    let overlap_len = SEG_OVERLAP_SEC * sample_rate as usize; // 重叠（样本数）
    let chunk_len = seg_len + overlap_len;                     // 每段实际发送长度
    let stride = seg_len;                                      // 窗口前进步长

    let mut results: Vec<String> = Vec::new();
    let mut offset = 0usize;

    // 滑动窗口切段
    while offset + chunk_len <= samples.len() {
        let seg = &samples[offset..offset + chunk_len];
        let text = engine.transcribe(seg, sample_rate)?;
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            results.push(trimmed.to_string());
        }
        offset += stride;
        let done_sec = (offset as f64 / sample_rate as f64).min(total_sec);
        on_progress(done_sec, total_sec);
    }

    // 剩余不足一段 → 作为最后一段（CapsWriter 的 is_final）
    if offset < samples.len() {
        let seg = &samples[offset..];
        let text = engine.transcribe(seg, sample_rate)?;
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            results.push(trimmed.to_string());
        }
        on_progress(total_sec, total_sec);
    }

    if results.is_empty() {
        return Err("分批转写结果为空（音频可能无有效语音）".into());
    }

    Ok(results.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用假引擎：记录每次收到的样本长度，返回固定文本
    struct FakeEngine {
        received: std::sync::Mutex<Vec<usize>>,
        total_calls: std::sync::atomic::AtomicUsize,
    }

    impl FakeEngine {
        fn new() -> Self {
            Self {
                received: std::sync::Mutex::new(Vec::new()),
                total_calls: std::sync::atomic::AtomicUsize::new(0),
            }
        }
        fn calls(&self) -> usize {
            self.total_calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl AsrEngine for FakeEngine {
        fn framework(&self) -> &'static str {
            "fake"
        }
        fn load_model(&self, _name: &str) -> Result<(), String> {
            Ok(())
        }
        fn unload(&self) -> Result<(), String> {
            Ok(())
        }
        fn is_loaded(&self) -> bool {
            true
        }
        fn current_model(&self) -> String {
            "fake".into()
        }
        fn transcribe(&self, samples: &[f32], _rate: u32) -> Result<String, String> {
            self.total_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.received.lock().unwrap().push(samples.len());
            Ok("识别文本".into())
        }
        fn vram_estimate_mb(&self) -> Option<u64> {
            None
        }
    }

    #[test]
    fn test_short_audio_single_call() {
        // 30s 音频 → 单次调用，不分段
        let e = FakeEngine::new();
        let samples = vec![0.0f32; 30 * 16000];
        let text = transcribe_long(&e, &samples, 16000, &mut |_, _| {}).unwrap();
        assert_eq!(text, "识别文本");
        assert_eq!(e.calls(), 1);
    }

    #[test]
    fn test_300s_audio_5_chunks() {
        // 300s 音频 → 60s 步进，5 段 + 每段 4s 重叠
        let e = FakeEngine::new();
        let samples = vec![0.0f32; 300 * 16000];
        let mut progress: Vec<(f64, f64)> = Vec::new();
        let text = transcribe_long(&e, &samples, 16000, &mut |d, t| progress.push((d, t))).unwrap();
        assert_eq!(text, "识别文本\n识别文本\n识别文本\n识别文本\n识别文本");
        // 300s：offset 0,60,120,180,240 → 4 个满段 + 最后 60s 残留
        assert_eq!(e.calls(), 5, "300s 应切 5 段");
        // 每段长度：前 4 段 64s，最后一段 60s
        let recv = e.received.lock().unwrap();
        assert_eq!(recv.len(), 5);
        assert_eq!(recv[0], 64 * 16000);
        assert_eq!(recv[1], 64 * 16000);
        assert_eq!(recv[2], 64 * 16000);
        assert_eq!(recv[3], 64 * 16000);
        assert_eq!(recv[4], 60 * 16000);
        // 进度回调
        assert_eq!(progress.len(), 5);
        assert_eq!(progress[0].0, 60.0);
        assert_eq!(progress[0].1, 300.0);
        assert_eq!(progress[4].0, 300.0);
    }

    #[test]
    fn test_90s_audio_2_chunks() {
        // 90s：64s 满段 + 26s 残留（offset=60 → 剩 30s < 64s）
        let e = FakeEngine::new();
        let samples = vec![0.0f32; 90 * 16000];
        let text = transcribe_long(&e, &samples, 16000, &mut |_, _| {}).unwrap();
        assert_eq!(e.calls(), 2);
        let recv = e.received.lock().unwrap();
        assert_eq!(recv[0], 64 * 16000);
        assert_eq!(recv[1], 30 * 16000);
        assert!(text.contains("识别文本"));
    }
}
