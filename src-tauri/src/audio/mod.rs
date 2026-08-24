#![allow(dead_code)]

//! 音频处理模块
//!
//! 替代 Python 的 numpy + soundfile + sounddevice
//! 功能：WAV 读写、重采样、格式转换、麦克风采集

pub mod resample;
pub mod wav;
pub mod capture;

pub use resample::resample_linear;
pub use wav::decode_audio;

/// 音频格式
#[allow(dead_code)]
pub const SAMPLE_RATE_16K: u32 = 16000;
pub const SAMPLE_RATE_24K: u32 = 24000;
pub const SAMPLE_RATE_48K: u32 = 48000;

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
