/**
 * 渲染进程侧：麦克风采集 + 音频设备枚举。
 *
 * 主进程没有音频栈，采集走 Web 标准 API：
 *   getUserMedia → AudioContext → ScriptProcessorNode → 累积 Float32 样本
 * 采集结束后线性重采样到 16kHz 单声道，再回传主进程。
 *
 * 主进程通过 `capture:command` / `audio-devices:command` 通道下发指令，
 * 这里用 `window.voxflow.capture.respond(...)` 回执。
 */

const TARGET_SAMPLE_RATE = 16000

interface Recorder {
  stop(): { samples: Float32Array; sampleRate: number; seconds: number; peak: number }
}

let recorder: Recorder | null = null
let started = false

/** 线性重采样（与主进程 `audio/resample.ts` 同一算法） */
function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
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

/** 多声道转单声道（取均值） */
function toMono(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return samples
  const frames = Math.floor(samples.length / channels)
  const out = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += samples[f * channels + c]
    out[f] = sum / channels
  }
  return out
}

/** 开始采集 */
async function startRecording(): Promise<void> {
  if (started) return
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  })

  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  // ScriptProcessor 虽已废弃，但在 Electron 里是兼容性最稳的采样回调方式
  const processor = ctx.createScriptProcessor(4096, 1, 1)

  const chunks: Float32Array[] = []
  let total = 0
  let peak = 0

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    chunks.push(new Float32Array(input))
    total += input.length
    for (let i = 0; i < input.length; i++) {
      const v = Math.abs(input[i])
      if (v > peak) peak = v
    }
  }

  source.connect(processor)
  // ScriptProcessor 必须连到 destination 才会被调度（用零增益避免回放）
  const mute = ctx.createGain()
  mute.gain.value = 0
  processor.connect(mute)
  mute.connect(ctx.destination)

  started = true
  recorder = {
    stop() {
      const merged = new Float32Array(total)
      let offset = 0
      for (const c of chunks) {
        merged.set(c, offset)
        offset += c.length
      }
      const mono = toMono(merged, 1)
      const resampled = resampleLinear(mono, ctx.sampleRate, TARGET_SAMPLE_RATE)
      const seconds = resampled.length / TARGET_SAMPLE_RATE

      processor.onaudioprocess = null
      try {
        source.disconnect()
        processor.disconnect()
        mute.disconnect()
      } catch {
        /* 忽略断开异常 */
      }
      for (const track of stream.getTracks()) track.stop()
      void ctx.close().catch(() => {})

      recorder = null
      started = false
      return { samples: resampled, sampleRate: TARGET_SAMPLE_RATE, seconds, peak }
    }
  }
}

/** 列出音频输入设备 */
async function listAudioDevices(): Promise<{
  status: 'audio_devices'
  devices: { id: string; name: string; channels: number; isDefault: boolean }[]
  current: string
  currentName: string
}> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  const inputs = devices.filter((d) => d.kind === 'audioinput')
  const list = inputs.map((d, i) => ({
    id: d.deviceId,
    name: d.label || `麦克风 ${i + 1}`,
    // MediaDeviceInfo.channelCount 不在标准 DOM 类型里（部分实现才有）
    channels: 1,
    isDefault: d.deviceId === 'default' || i === 0
  }))
  const current = list.find((d) => d.isDefault)?.id ?? list[0]?.id ?? ''
  return {
    status: 'audio_devices',
    devices: list,
    current,
    currentName: list.find((d) => d.id === current)?.name ?? ''
  }
}

/** 注册主进程指令监听（渲染进程入口调用一次） */
export function registerCaptureBridge(): void {
  window.voxflow.capture.onCommand(({ action, requestId, seconds }) => {
    if (action === 'start') {
      void startRecording()
        .then(() => window.voxflow.capture.respond(requestId, true, { samples: new Float32Array(0), sampleRate: TARGET_SAMPLE_RATE, seconds: 0, peak: 0 }))
        .catch((e: unknown) =>
          window.voxflow.capture.respond(requestId, false, undefined, e instanceof Error ? e.message : String(e))
        )
    } else if (action === 'stop') {
      if (!recorder) {
        window.voxflow.capture.respond(requestId, false, undefined, '录音未在运行')
        return
      }
      const result = recorder.stop()
      window.voxflow.capture.respond(requestId, true, result)
    } else if (action === 'record') {
      // 定长录音：录 seconds 秒后自动停止并回传（用于 TTS 克隆参考音频）
      const dur = typeof seconds === 'number' && seconds > 0 ? seconds : 6
      void startRecording()
        .then(() => new Promise<void>((resolve) => window.setTimeout(resolve, dur * 1000)))
        .then(() => {
          if (!recorder) throw new Error('录音未在运行')
          const result = recorder.stop()
          window.voxflow.capture.respond(requestId, true, result)
        })
        .catch((e: unknown) => {
          if (recorder) recorder.stop()
          window.voxflow.capture.respond(requestId, false, undefined, e instanceof Error ? e.message : String(e))
        })
    }
  })

  window.voxflow.audioDevices.onCommand(({ requestId }) => {
    void listAudioDevices()
      .then((result) => window.voxflow.audioDevices.respond(requestId, true, result))
      .catch((e: unknown) =>
        window.voxflow.audioDevices.respond(requestId, false, undefined, e instanceof Error ? e.message : String(e))
      )
  })
}
