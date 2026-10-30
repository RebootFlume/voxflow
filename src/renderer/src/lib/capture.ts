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

import { useAppStore } from "@/stores";

const TARGET_SAMPLE_RATE = 16000

/** 音频设备条目（字段与主进程 `src/main/system/audio-devices.ts` 的 AudioDeviceInfo 对齐） */
interface DeviceEntry {
  id: string;
  name: string;
  channels: number;
  isDefault: boolean;
}

interface Recorder {
  stop(): { samples: Float32Array; sampleRate: number; seconds: number; peak: number }
}

let recorder: Recorder | null = null
let started = false

/**
 * deviceId → 真实设备名缓存。
 *
 * 为什么需要：浏览器规范要求「拿到麦克风权限之前 deviceInfo.label 为空」，
 * 授权之后枚举才会给出真实名称（Rust 版用 cpal 无此限制，始终拿得到真名）。
 * 这里把授权后拿到的名字缓存下来，后续枚举万一又返回空 label
 * （权限被撤销 / 设备热插拔）时也不会退化成「麦克风 N」。
 */
const labelCache = new Map<string, string>()

/**
 * 录音实际使用的设备 id（空 = 交由系统默认）。
 * Electron 侧只有拿到麦克风权限后才有真实 deviceId，
 * 所以枚举时记录「当前默认输入设备」，录音时显式带给 getUserMedia。
 */
let selectedDeviceId = ""

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

/**
 * 打开麦克风。
 *
 * 优先带上真实 deviceId（授权后枚举得到），这样录的是界面上显示的那台设备；
 * 设备被拔掉/被独占导致指定失败时，回退到系统默认，
 * 保证不会因为「选不到设备」就完全录不了音。
 */
async function openMicrophone(): Promise<MediaStream> {
  const base: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  }
  if (selectedDeviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...base, deviceId: { exact: selectedDeviceId } }
      })
    } catch {
      /* 指定设备不可用 → 回退系统默认 */
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: base })
}

/** 开始采集 */
async function startRecording(): Promise<void> {
  if (started) return
  const stream = await openMicrophone()
  // 麦克风已授权：此刻起 enumerateDevices 才会给出真实设备名，刷新一次
  void refreshLabelsFromEnum()

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

/**
 * 去掉 Chromium 给 default/communications 伪设备加的前缀。
 * 伪设备的 label 形如 "Default - 麦克风 (Realtek)"，展示时要去掉前缀才干净。
 */
function stripPseudoPrefix(label: string): string {
  return label.replace(/^(default|communications|默认|通信)\s*[-–—:]\s*/i, "")
}

/** 枚举输入设备（授权后才有真实 label） */
async function enumerateInputs(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === "audioinput")
}

/**
 * 构造设备列表：始终包含 default（系统默认输入设备），
 * 拿不到 label 时退回「麦克风 N」，保证界面不会空着。
 */
function buildDeviceList(inputs: MediaDeviceInfo[]): DeviceEntry[] {
  // 'communications' 是 Chromium 的第二个伪设备（默认通信设备），与 default 重复，展示上略过
  const realInputs = inputs.filter((d) => d.deviceId !== "communications")
  const defaultInput = realInputs.find((d) => d.deviceId === "default")
  const others = realInputs.filter((d) => d.deviceId !== "default")

  const list: DeviceEntry[] = []
  const push = (d: MediaDeviceInfo, isDefault: boolean): void => {
    const label = d.label ? stripPseudoPrefix(d.label) : labelCache.get(d.deviceId)
    list.push({
      id: d.deviceId,
      name: label || `麦克风 ${list.length + 1}`,
      channels: 1,
      isDefault
    })
  }
  if (defaultInput) push(defaultInput, true)
  for (const d of others) push(d, false)
  if (!list.length) list.push({ id: "default", name: "麦克风 1", channels: 1, isDefault: true })
  // 平台没给 'default' 伪设备时，把第一台物理设备标成默认，保证 isDefault 语义一致
  else if (!list.some((d) => d.isDefault)) list[0].isDefault = true
  return list
}

/**
 * 选出「当前输入设备」。
 *
 * Chromium 会额外返回 deviceId = 'default' / 'communications' 两个伪设备，
 * 它们的 label 是「真实设备名 + 前缀」；这里反查出对应的物理设备条目，
 * 拿到干净的设备名和可用的 deviceId（Rust 版 cpal 直接就是真名真 id）。
 */
function pickCurrentDevice(inputs: MediaDeviceInfo[], list: DeviceEntry[]): { id: string; name: string } {
  const defaultInput = inputs.find((d) => d.deviceId === "default")
  const physical = inputs.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications")
  if (defaultInput?.label) {
    const target = stripPseudoPrefix(defaultInput.label)
    const hit = physical.find((d) => d.label && stripPseudoPrefix(d.label) === target)
    if (hit) return { id: hit.deviceId, name: stripPseudoPrefix(hit.label) }
    return { id: "default", name: target }
  }
  const first = physical[0]
  if (first) {
    const name = first.label ? stripPseudoPrefix(first.label) : labelCache.get(first.deviceId) ?? ""
    return { id: first.deviceId, name: name || "麦克风 1" }
  }
  const fallback = list[0]
  return fallback ? { id: fallback.id, name: fallback.name } : { id: "", name: "" }
}

/** 列出音频输入设备 */
async function listAudioDevices(): Promise<{
  status: 'audio_devices'
  devices: DeviceEntry[]
  current: string
  currentName: string
}> {
  const inputs = await enumerateInputs()
  // 授权后枚举才有真实 label，顺手回填缓存
  for (const d of inputs) if (d.label) labelCache.set(d.deviceId, stripPseudoPrefix(d.label))

  const list = buildDeviceList(inputs)
  const current = pickCurrentDevice(inputs, list)
  selectedDeviceId = current.id
  return {
    status: 'audio_devices',
    devices: list,
    // 与 Rust 版对齐：current/currentName 给的是「当前设备名」（Rust: lib.rs:630-631），
    // 而不是 deviceId —— 前端 AsrPanel 展示的就是这个名字
    current: current.name,
    currentName: current.name
  }
}

/**
 * 重新枚举并刷新设备真名（不发 getUserMedia）。
 * 授权状态下枚举才有真实 label，这里顺带把名字同步进 store，
 * 覆盖「启动兜底查询早于麦克风权限落地」的竞态。
 */
async function refreshLabelsFromEnum(): Promise<void> {
  try {
    const inputs = await enumerateInputs()
    for (const d of inputs) if (d.label) labelCache.set(d.deviceId, stripPseudoPrefix(d.label))
    const list = buildDeviceList(inputs)
    const current = pickCurrentDevice(inputs, list)
    if (current.id) selectedDeviceId = current.id
    useAppStore.getState().setAudioDevices(current.name, current.name)
  } catch {
    /* 枚举失败：保持现状（退化显示「麦克风 N」） */
  }
}

/**
 * 申请一次麦克风权限（拿到立刻停掉轨道，不录音），让后续枚举能返回真实设备名。
 *
 * 为什么需要：浏览器规范要求未授权时 deviceInfo.label 为空，
 * 只有真正打开过一次麦克风之后，enumerateDevices 才会给出真实名称。
 * 主进程已放行 media 权限（src/main/index.ts 的 setPermissionRequestHandler），
 * 不会弹窗；失败也只是退回「麦克风 N」，不影响功能。
 */
async function probeMicrophonePermission(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
  if (!stream) return
  for (const track of stream.getTracks()) track.stop()
  await refreshLabelsFromEnum()
}

/** 注册主进程指令监听（渲染进程入口调用一次） */
export function registerCaptureBridge(): void {
  // 启动即申请一次麦克风权限（拿到立刻停），让「输入设备」能显示真实名称而不是「麦克风 1」
  void probeMicrophonePermission()

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
