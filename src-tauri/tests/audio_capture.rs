//! 音频采集（cpal 麦克风）集成测试
//!
//! 前置条件：系统有可用麦克风输入设备。
//! 运行：cargo test --test audio_capture -- --ignored --nocapture
//!
//! 说明：这个测试录 1 秒真实麦克风音频并断言有数据返回。
//! 在 CI/无麦克风环境会失败，故标记 #[ignore]。

use std::time::Duration;
use voxflow_lib::audio::capture::AudioCapture;

#[test]
#[ignore] // 需要麦克风
fn test_capture_start_stop_returns_samples() {
    let mut cap = AudioCapture::new(16_000);
    cap.start().expect("start capture");

    // 录 1 秒
    std::thread::sleep(Duration::from_millis(1000));

    let samples = cap.stop().expect("stop capture");
    println!("captured {} samples ({} ms @16k)", samples.len(), samples.len() * 1000 / 16_000);

    // 1 秒 @16k 应该有 ~16000 samples，允许上下浮动（启动延迟等）
    assert!(samples.len() > 4_000, "expected >4000 samples, got {}", samples.len());

    // 样本值在有效范围
    for &s in samples.iter().take(1000) {
        assert!(s.is_finite(), "sample not finite");
        assert!(s >= -1.0 && s <= 1.0, "sample out of range: {s}");
    }
}

#[test]
#[ignore] // 需要麦克风
fn test_capture_start_twice_idempotent() {
    let mut cap = AudioCapture::new(16_000);
    cap.start().expect("first start");
    cap.start().expect("second start (idempotent)");
    std::thread::sleep(Duration::from_millis(200));
    let samples = cap.stop().expect("stop");
    println!("captured {} samples", samples.len());
    assert!(samples.len() >= 0);
}
