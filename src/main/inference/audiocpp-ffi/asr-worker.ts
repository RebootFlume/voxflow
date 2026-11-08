/**
 * audio.cpp ASR 的 worker 进程入口。
 *
 * 只做「收命令 → 转给会话 → 回结果」，模型族与路径由主进程解析好再发过来。
 */

import { runFfiWorker } from '../ffi-worker/worker'
import { AudiocppAsrSession } from './session-asr'
import type { LoadAsrRequest, TranscribeReply, TranscribeRequest } from './protocol'

let session: AudiocppAsrSession | null = null

function closeSession(): void {
  session?.close()
  session = null
}

runFfiWorker({
  label: 'audiocpp-asr',
  createHandlers: (reportStage) => ({
    load: (payload) => {
      const req = payload as LoadAsrRequest
      closeSession()
      reportStage('loading')
      session = AudiocppAsrSession.open({
        runtimeDir: req.runtimeDir,
        modelPath: req.modelPath,
        familyHint: req.familyHint,
        backend: req.backend,
        numThreads: req.numThreads
      })
      reportStage('ready')
      return null
    },
    unload: () => {
      closeSession()
      return null
    },
    transcribe: (payload): TranscribeReply => {
      const req = payload as TranscribeRequest
      if (!session) throw new Error('ASR 模型未加载')
      return { text: session.transcribe(req.samples, req.sampleRate) }
    }
  }),
  onDispose: closeSession
})
