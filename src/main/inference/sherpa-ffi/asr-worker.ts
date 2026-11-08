/**
 * sherpa-onnx ASR 的 worker 进程入口。
 *
 * 只做「收命令 → 转给会话 → 回结果」，不含模型解析（路径都由主进程给齐）。
 */

import { runFfiWorker } from '../ffi-worker/worker'
import { toFloat32Array } from '../ffi-worker/pcm'
import { SherpaAsrSession } from './session-asr'
import type { LoadAsrRequest, TranscribeRequest } from './protocol'

let session: SherpaAsrSession | null = null

function closeSession(): void {
  session?.close()
  session = null
}

runFfiWorker({
  label: 'sherpa-asr',
  createHandlers: (reportStage) => ({
    load: (payload) => {
      const req = payload as LoadAsrRequest
      closeSession()
      session = SherpaAsrSession.open({
        runtimeDir: req.runtimeDir,
        family: req.family,
        modelPath: req.modelPath,
        tokensPath: req.tokensPath,
        provider: req.provider,
        numThreads: req.numThreads,
        language: req.language,
        useItn: req.useItn,
        onStage: reportStage
      })
      return null
    },
    unload: () => {
      closeSession()
      return null
    },
    transcribe: (payload) => {
      const req = payload as TranscribeRequest
      if (!session) throw new Error('模型未加载')
      return session.transcribe(toFloat32Array(req.pcm), req.sampleRate)
    }
  }),
  onDispose: closeSession
})
