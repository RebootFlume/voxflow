/**
 * FFI worker 进程入口。
 *
 * 为什么要单独进程：llama.cpp 是原生 DLL，段错误会带走整个进程。
 * 放在子进程里，崩溃只影响 worker，主进程（UI）不受影响，还能自动重启。
 *
 * 进程内只做三件事：收命令 → 调会话 → 回事件。不含任何业务判断。
 */

import { LlamaSession } from './session'
import type { WorkerCommand, WorkerEvent } from './protocol'

let session: LlamaSession | null = null

function send(event: WorkerEvent): void {
  process.send?.(event)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 进程边界上的类型校验：把传进来的采样统一成 Float32Array。
 *
 * IPC 序列化方式一变（比如退回 JSON），Float32Array 会变成普通对象；
 * 与其让下游拿到 NaN 再炸，不如在入口就明确拒绝。
 */
function toPcm(input: unknown): Float32Array {
  if (input instanceof Float32Array) return input
  if (Array.isArray(input)) return Float32Array.from(input as number[])
  if (ArrayBuffer.isView(input) && 'length' in input) {
    return Float32Array.from(input as unknown as ArrayLike<number>)
  }
  throw new Error('转写请求里的音频采样格式不正确')
}

process.on('message', (cmd: WorkerCommand) => {
  try {
    switch (cmd.kind) {
      case 'load': {
        // 换模型前先释放旧的
        session?.close()
        session = null
        const req = cmd.payload
        session = LlamaSession.open({
          libsDir: req.libsDir,
          modelPath: req.modelPath,
          mmprojPath: req.mmprojPath,
          device: req.device,
          ctxSize: req.ctxSize,
          onStage: (stage) => send({ kind: 'stage', stage })
        })
        send({ kind: 'reply', id: cmd.id, ok: true, payload: null })
        break
      }
      case 'unload': {
        session?.close()
        session = null
        send({ kind: 'reply', id: cmd.id, ok: true, payload: null })
        break
      }
      case 'transcribe': {
        if (!session) throw new Error('模型未加载')
        const { pcm, sampleRate, context } = cmd.payload
        const text = session.transcribe(toPcm(pcm), sampleRate, context)
        send({ kind: 'reply', id: cmd.id, ok: true, payload: text })
        break
      }
    }
  } catch (err) {
    // 完整堆栈留在 worker 的 stderr（诊断用），主进程只拿到一句人话
    console.error('[llama-ffi] 命令失败:', err)
    send({ kind: 'reply', id: cmd.id, ok: false, error: errorText(err) })
  }
})

// 父进程退出 → 跟着退出（避免留下占显存的孤儿）
process.on('disconnect', () => {
  session?.close()
  session = null
  process.exit(0)
})
