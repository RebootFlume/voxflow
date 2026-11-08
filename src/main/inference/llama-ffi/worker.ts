/**
 * llama.cpp FFI worker 进程入口。
 *
 * 为什么要单独进程：llama.cpp 是原生 DLL，段错误会带走整个进程。
 * 放在子进程里，崩溃只影响 worker，主进程（UI）不受影响，还能自动重启。
 *
 * 进程内只做三件事：收命令 → 调会话 → 回事件。不含任何业务判断。
 */

import { runFfiWorker } from '../ffi-worker/worker'
import { toFloat32Array } from '../ffi-worker/pcm'
import { LlamaSession } from './session'
import type { LoadRequest, TranscribeRequest } from './protocol'

let session: LlamaSession | null = null

function closeSession(): void {
  session?.close()
  session = null
}

runFfiWorker({
  label: 'llama-ffi',
  createHandlers: (reportStage) => ({
    load: (payload) => {
      // 换模型前先释放旧的
      closeSession()
      const req = payload as LoadRequest
      session = LlamaSession.open({
        libsDir: req.libsDir,
        modelPath: req.modelPath,
        mmprojPath: req.mmprojPath,
        device: req.device,
        ctxSize: req.ctxSize,
        onStage: reportStage
      })
      // 回传引擎自报的显存占用（加载前后的设备空闲显存差值）
      return { vramMb: session.vramMb() }
    },
    unload: () => {
      closeSession()
      return null
    },
    transcribe: (payload) => {
      if (!session) throw new Error('模型未加载')
      const { pcm, sampleRate, context } = payload as TranscribeRequest
      return session.transcribe(toFloat32Array(pcm), sampleRate, context)
    }
  }),
  onDispose: closeSession
})
