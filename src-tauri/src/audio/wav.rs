//! WAV 音频读写
//!
//! 使用 hound crate 实现 WAV 读写（替代 Python 的 soundfile.read / wave）
//! 支持从文件（read_wav）与内存字节流（decode_audio）两种解码入口。

use std::io::{Cursor, Read};
use std::path::Path;

/// 从 hound reader 提取 f32 样本（支持 16/24/32 位深）
fn read_samples<R: Read>(reader: hound::WavReader<R>) -> Result<(Vec<f32>, u32, u16), String> {
    let spec = reader.spec();
    let sample_rate = spec.sample_rate;
    let channels = spec.channels;

    let samples: Vec<f32> = match spec.bits_per_sample {
        16 => reader
            .into_samples::<i16>()
            .filter_map(Result::ok)
            .map(|s| s as f32 / 32768.0)
            .collect(),
        24 => reader
            .into_samples::<i32>()
            .filter_map(Result::ok)
            .map(|s| (s >> 8) as f32 / 8388608.0)
            .collect(),
        32 => reader
            .into_samples::<i32>()
            .filter_map(Result::ok)
            .map(|s| s as f32 / 2147483648.0)
            .collect(),
        _ => return Err(format!("unsupported bits per sample: {}", spec.bits_per_sample)),
    };

    Ok((samples, sample_rate, channels))
}

/// 读取 WAV 文件，返回 (samples, sample_rate, channels)
pub fn read_wav(path: &Path) -> Result<(Vec<f32>, u32, u16), String> {
    let reader = hound::WavReader::open(path).map_err(|e| format!("WAV open failed: {e}"))?;
    read_samples(reader)
}

/// 写入 WAV 文件（16bit PCM）
pub fn write_wav(path: &Path, samples: &[f32], sample_rate: u32, channels: u16) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = hound::WavWriter::create(path, spec)
        .map_err(|e| format!("WAV create failed: {e}"))?;

    for &s in samples {
        let sample = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        writer
            .write_sample(sample)
            .map_err(|e| format!("WAV write failed: {e}"))?;
    }

    writer
        .finalize()
        .map_err(|e| format!("WAV finalize failed: {e}"))?;

    Ok(())
}

/// 从字节流解码音频，返回 (samples_16kHz_mono, 16000)
///
/// 直接基于内存解码（hound 支持 `WavReader::new(io::Cursor)`），
/// 不写临时文件 —— 修复旧实现用固定 pid 临时文件并发解码互相覆盖的问题。
pub fn decode_audio(data: &[u8]) -> Result<(Vec<f32>, u32), String> {
    let reader = hound::WavReader::new(Cursor::new(data))
        .map_err(|e| format!("WAV parse failed: {e}"))?;

    let (mut samples, sample_rate, channels) = read_samples(reader)?;

    // 多声道转单声道
    if channels > 1 {
        samples = super::to_mono(&samples, channels as usize);
    }

    // 重采样到 16kHz（如果需要）
    let target_rate = super::SAMPLE_RATE_16K;
    if sample_rate != target_rate {
        samples = super::resample_linear(&samples, sample_rate, target_rate);
    }

    Ok((samples, target_rate))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_write_read_roundtrip() {
        let path = std::env::temp_dir().join(format!("voxflow_test_{}.wav", std::process::id()));
        let samples = vec![0.0, 0.5, -0.5, 1.0, -1.0];

        write_wav(&path, &samples, 16000, 1).unwrap();
        let (read_samples, rate, channels) = read_wav(&path).unwrap();

        assert_eq!(rate, 16000);
        assert_eq!(channels, 1);
        assert_eq!(read_samples.len(), samples.len());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_decode_audio_in_memory() {
        // 构造 1 秒 16kHz 单声道 WAV 字节流，验证内存解码（不写临时文件）
        let mut buf = Vec::new();
        {
            let mut w = hound::WavWriter::new(std::io::Cursor::new(&mut buf), hound::WavSpec {
                channels: 1,
                sample_rate: 16000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            })
            .unwrap();
            for i in 0..16000 {
                let s = (i as f32 / 16000.0 * 32767.0) as i16;
                w.write_sample(s).unwrap();
            }
            w.finalize().unwrap();
        }
        let (samples, rate) = decode_audio(&buf).unwrap();
        assert_eq!(rate, 16000);
        assert_eq!(samples.len(), 16000);
    }
}
