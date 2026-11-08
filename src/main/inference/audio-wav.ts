/**
 * PCM → WAV 编码（16bit 单声道）。
 *
 * 独立成模块：HTTP 上传（multipart）与进程内 FFI（mtmd 音频前端）需要同一份
 * WAV 编码，避免两处实现漂移。
 */

/**
 * 把 Float32 采样编码为 WAV 字节。
 *
 * 量化规则与历史实现保持一致：限幅到 [-1, 1] 后截断取整（-1 → -32767）。
 */
export function encodePcmToWav(samples: Float32Array, sampleRate: number): Buffer {
  const channels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)
  const dataSize = samples.length * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // PCM fmt chunk 大小
  buf.writeUInt16LE(1, 20) // audio format = PCM
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(bitsPerSample, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.trunc(s * 32767), 44 + i * 2)
  }
  return buf
}
