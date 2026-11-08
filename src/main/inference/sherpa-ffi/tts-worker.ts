/**
 * sherpa-onnx TTS 的 worker 进程入口。
 *
 * 只做「收命令 → 转给会话 → 回结果」，模型配置由主进程解析好再发过来。
 */

import { runFfiWorker } from '../ffi-worker/worker'
import { toFloat32Array } from '../ffi-worker/pcm'
import { SherpaTtsSession } from './session-tts'
import type { LoadTtsRequest, SynthesizeRequest, SynthesizeReply } from './protocol'

let session: SherpaTtsSession | null = null

function closeSession(): void {
  session?.close()
  session = null
}

/** [-1,1] 浮点 → 16bit PCM（限幅后截断） */
function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    out[i] = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff)
  }
  return out
}

runFfiWorker({
  label: 'sherpa-tts',
  createHandlers: (reportStage) => ({
    load: (payload) => {
      const req = payload as LoadTtsRequest
      closeSession()
      reportStage('loading')
      session = SherpaTtsSession.open({
        runtimeDir: req.runtimeDir,
        model: req.model,
        provider: req.provider,
        numThreads: req.numThreads
      })
      reportStage('ready')
      return null
    },
    unload: () => {
      closeSession()
      return null
    },
    synthesize: (payload): SynthesizeReply => {
      const req = payload as SynthesizeRequest
      if (!session) throw new Error('TTS 模型未加载')
      const audio = session.synthesize(req.text, {
        sid: req.sid,
        speed: req.speed,
        referenceAudio: req.referenceAudio ? toFloat32Array(req.referenceAudio) : null,
        referenceSampleRate: req.referenceSampleRate,
        referenceText: req.referenceText
      })
      return { samples: toInt16(audio.samples), sampleRate: audio.sampleRate }
    }
  }),
  onDispose: closeSession
})
