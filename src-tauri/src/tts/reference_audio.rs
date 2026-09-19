//! 克隆参考音频的录音采集（16kHz 单声道 wav）
//!
//! 为什么需要：克隆音色原本只能"选文件"——用户手上没有合适的参考音频时，
//! 等于功能不可用。这里复用 ASR 的录音链路（`audio::capture`）录一段固定时长的参考音。
//!
//! 与 Tauri 运行时解耦：命令层只负责取数据目录 + 进阻塞池，本模块可单测。

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 默认时长（秒）与允许区间
pub const DEFAULT_SECONDS: f64 = 6.0;
pub const MIN_SECONDS: f64 = 3.0;
pub const MAX_SECONDS: f64 = 30.0;
/// 采样率（引擎侧的参考音频口径）
pub const SAMPLE_RATE: u32 = 16_000;
/// 数据目录里保留的参考音个数（每次录音写一个新文件，必须清理否则无限堆积）
pub const KEEP_FILES: usize = 5;

/// 时长钳制（纯函数）：NaN/非正数用默认值，否则收敛到 [MIN, MAX]
pub fn clamp_seconds(seconds: f64) -> f64 {
    if !seconds.is_finite() || seconds <= 0.0 {
        return DEFAULT_SECONDS;
    }
    seconds.clamp(MIN_SECONDS, MAX_SECONDS)
}

/// 录制并落盘到 `dir`，返回 `{ path, seconds, sample_rate, peak }`。
///
/// `peak` 供前端提示"没录到声音"。**必须整段在同一线程内完成**：
/// cpal 流的建/停/释放不能在跨线程（`AudioCapture` 非 Send）。
pub fn record_to(dir: &Path, seconds: f64) -> Result<serde_json::Value, String> {
    let mut capture = crate::audio::capture::AudioCapture::new(SAMPLE_RATE);
    capture.start()?;
    std::thread::sleep(Duration::from_secs_f64(seconds));
    let samples = capture.stop()?;

    // 半秒以下视为没录上（设备打不开时 start 可能"成功"却拿不到数据）
    if samples.len() < SAMPLE_RATE as usize / 2 {
        return Err(format!("录音过短（{} 个采样），请检查麦克风", samples.len()));
    }
    let peak = samples.iter().fold(0f32, |m, s| m.max(s.abs()));

    std::fs::create_dir_all(dir).map_err(|e| format!("创建参考音目录失败: {e}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("ref-{stamp}.wav"));
    crate::audio::wav::write_wav(&path, &samples, SAMPLE_RATE, 1)?;
    prune(dir, KEEP_FILES);

    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "seconds": seconds,
        "sample_rate": SAMPLE_RATE,
        "peak": peak,
    }))
}

/// 只保留最近 `keep` 个 `ref-*.wav`（best-effort：失败不影响录音）。
///
/// 文件名是 `ref-<毫秒时间戳>.wav` ⇒ 同目录内**字典序 ≈ 时间序**，无需读文件时间。
pub fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<std::path::PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("ref-") && n.ends_with(".wav"))
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort();
    for old in &files[..files.len() - keep] {
        let _ = std::fs::remove_file(old);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prune_keeps_newest_and_ignores_foreign_files() {
        let dir = std::env::temp_dir().join(format!("voxflow_prune_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for ms in [100u128, 200, 300, 400, 500, 600] {
            std::fs::write(dir.join(format!("ref-{ms}.wav")), b"x").unwrap();
        }
        // 非本次录音命名的文件不能被动（例如用户手动放进来的参考音）
        std::fs::write(dir.join("my-voice.wav"), b"x").unwrap();

        prune(&dir, 3);

        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        left.sort();
        assert_eq!(left, vec!["my-voice.wav", "ref-400.wav", "ref-500.wav", "ref-600.wav"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_clamp_seconds() {
        assert_eq!(clamp_seconds(6.0), 6.0);
        // 越界收敛
        assert_eq!(clamp_seconds(0.5), MIN_SECONDS);
        assert_eq!(clamp_seconds(600.0), MAX_SECONDS);
        // 非有限/非正数 → 默认值（前端传 null/NaN 时不能录 0 秒）
        assert_eq!(clamp_seconds(f64::NAN), DEFAULT_SECONDS);
        assert_eq!(clamp_seconds(0.0), DEFAULT_SECONDS);
        assert_eq!(clamp_seconds(-3.0), DEFAULT_SECONDS);
    }

    /// 按需真机冒烟（占麦克风 ~3s，写临时目录；CI 默认不跑）：
    /// `cargo test --lib record_reference_smoke -- --ignored --nocapture`
    #[test]
    #[ignore = "占用真实麦克风，按需手动运行"]
    fn record_reference_smoke() {
        let dir = std::env::temp_dir().join(format!("voxflow_ref_{}", std::process::id()));
        let v = record_to(&dir, MIN_SECONDS).expect("录音应成功");
        println!("录到: {v}");
        let p = std::path::PathBuf::from(v["path"].as_str().unwrap());
        assert!(p.is_file(), "wav 应落盘");
        // 回读校验：采样率与单声道必须与声明一致（探测出的设备格式经 resample 后）
        let (_s, sr, ch) = crate::audio::wav::read_wav(&p).expect("可回读");
        assert_eq!(sr, SAMPLE_RATE);
        assert_eq!(ch, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
