/**
 * 音频重采样 —— 对齐 Rust 版 `src-tauri/src/audio/resample.rs`。
 * 线性插值（等价于 Python np.interp）。
 */

/** 简单线性重采样 */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples

  const ratio = fromRate / toRate
  const nOut = Math.floor(samples.length / ratio)
  if (nOut === 0) return new Float32Array(0)

  const out = new Float32Array(nOut)
  for (let i = 0; i < nOut; i++) {
    const srcPos = i * ratio
    const idx = Math.floor(srcPos)
    const frac = srcPos - idx
    const a = samples[Math.min(idx, samples.length - 1)]
    const b = samples[Math.min(idx + 1, samples.length - 1)]
    out[i] = a + (b - a) * frac
  }
  return out
}

/** 重采样到目标采样率 */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  return resampleLinear(samples, fromRate, toRate)
}
