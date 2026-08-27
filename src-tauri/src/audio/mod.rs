#![allow(dead_code)]

//! 音频处理模块
//!
//! 替代 Python 的 numpy + soundfile + sounddevice
//! 功能：多格式解码、重采样、格式转换、麦克风采集
//!
//! ## 解码器可插拔（规则 12）
//!
//! - `wav.rs`：WAV 快速路径（hound，纯 Rust，无外部依赖）
//! - `ffmpeg_decoder.rs`：多格式（mp3/flac/ogg/m4a/webm 等）→ ffmpeg 子进程
//! - `decode_audio` 统一入口：根据文件头自动选择解码器，上层不感知格式

pub mod resample;
pub mod wav;
pub mod capture;
pub mod ffmpeg_decoder;

pub use resample::resample_linear;
pub use wav::decode_audio;

/// 音频格式
#[allow(dead_code)]
pub const SAMPLE_RATE_16K: u32 = 16000;
pub const SAMPLE_RATE_24K: u32 = 24000;
pub const SAMPLE_RATE_48K: u32 = 48000;

/// 多格式解码入口（规则 12：统一入口，上层不感知格式）
///
/// - WAV（RIFF 头）→ hound 快速路径（无外部依赖）
/// - 其他格式 → ffmpeg 子进程（需系统安装 ffmpeg）
/// 返回 (samples_16k_mono, 16000)
pub fn decode_any(data: &[u8], path: &std::path::Path) -> Result<(Vec<f32>, u32), String> {
    // WAV 快速路径：RIFF 头
    if data.len() >= 4 && &data[0..4] == b"RIFF" {
        return wav::decode_audio(data);
    }
    // 其他格式 → ffmpeg 子进程
    if !ffmpeg_decoder::ffmpeg_available() {
        return Err(format!(
            "不支持的格式（需要 ffmpeg 才能解码 {}）: 请安装 ffmpeg 并加入 PATH",
            path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| "未知".into())
        ));
    }
    ffmpeg_decoder::decode_with_ffmpeg(path)
}

/// float32 转 int16 PCM
#[allow(dead_code)]
pub fn float_to_int16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
        .collect()
}

/// int16 PCM 转 float32
#[allow(dead_code)]
pub fn int16_to_float(samples: &[i16]) -> Vec<f32> {
    samples.iter().map(|&s| s as f32 / 32768.0).collect()
}

/// 多声道转单声道（取均值）
pub fn to_mono(stereo: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return stereo.to_vec();
    }
    stereo
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}
