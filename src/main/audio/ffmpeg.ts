/**
 * FFmpeg 子进程音频解码（多格式：mp3/flac/ogg/m4a/webm/mp4 等）
 * —— 对齐 Rust 版 `src-tauri/src/audio/ffmpeg_decoder.rs`。
 *
 * 设计原则：
 * - 子进程隔离：ffmpeg 崩溃不影响主进程
 * - 输出 16kHz 单声道 float32（与 decode_audio 契约一致）
 *
 * ffmpeg: `ffmpeg -v error -i <input> -f s16le -ac 1 -ar 16000 -`（裸 PCM，不带 WAV 头）
 */

import { spawn } from 'child_process'

/** 检测 ffmpeg 是否可用（PATH 中） */
export function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-version'], { windowsHide: true, stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

/** 用 ffmpeg 解码音频文件为 16kHz 单声道 float32 */
export function decodeWithFfmpeg(path: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      ['-v', 'error', '-i', path, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'],
      { windowsHide: true }
    )

    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let spawnError: Error | null = null

    child.stdout?.on('data', (c: Buffer) => chunks.push(c))
    child.stderr?.on('data', (c: Buffer) => errChunks.push(c))
    child.on('error', (e) => {
      spawnError = new Error(`ffmpeg 启动失败: ${e.message}`)
    })
    child.on('close', (code) => {
      if (spawnError) return reject(spawnError)
      if (code !== 0) {
        const err = Buffer.concat(errChunks).toString('utf-8').trim()
        const last = err.split('\n').filter(Boolean).pop() ?? '未知错误'
        return reject(new Error(`ffmpeg 解码失败: ${last}`))
      }

      let pcm = Buffer.concat(chunks)
      if (pcm.length === 0) {
        return reject(new Error('ffmpeg 输出为空（音频可能损坏或无声音）'))
      }
      if (pcm.length % 2 !== 0) pcm = pcm.subarray(0, pcm.length - (pcm.length % 2))

      const count = Math.floor(pcm.length / 2)
      const samples = new Float32Array(count)
      for (let i = 0; i < count; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768.0

      resolve({ samples, sampleRate: 16000 })
    })
  })
}
