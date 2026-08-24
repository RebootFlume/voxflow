//! 音频重采样
//!
//! 替代 Python 的 np.interp 线性重采样

/// 简单线性重采样（与 Python np.interp 对齐，无外部依赖）
pub fn resample_linear(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || samples.is_empty() {
        return samples.to_vec();
    }

    let ratio = from_rate as f64 / to_rate as f64;
    let n_out = (samples.len() as f64 / ratio) as usize;
    if n_out == 0 {
        return Vec::new();
    }

    (0..n_out)
        .map(|i| {
            let src_pos = i as f64 * ratio;
            let idx = src_pos as usize;
            let frac = src_pos - idx as f64;
            let a = samples[idx.min(samples.len() - 1)];
            let b = samples[(idx + 1).min(samples.len() - 1)];
            a + (b - a) * frac as f32
        })
        .collect()
}

/// 重采样到目标采样率（对外接口，内部使用线性重采样）
/// 后续可替换为 rubato 做高质量重采样
pub fn resample(samples: &[f32], from_rate: u32, to_rate: u32) -> Result<Vec<f32>, String> {
    Ok(resample_linear(samples, from_rate, to_rate))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_linear_resample_16k_to_24k() {
        let samples = vec![0.0; 16000]; // 1 秒
        let result = resample_linear(&samples, 16000, 24000);
        assert_eq!(result.len(), 24000);
    }

    #[test]
    fn test_linear_resample_same_rate() {
        let samples = vec![1.0, 2.0, 3.0];
        let result = resample_linear(&samples, 16000, 16000);
        assert_eq!(result, samples);
    }

    #[test]
    fn test_linear_resample_empty() {
        let result = resample_linear(&[], 16000, 24000);
        assert!(result.is_empty());
    }
}
