/**
 * FFI worker 进程侧的通用循环（框架无关）。
 *
 * worker 只做三件事：收命令 → 交给处理器 → 回事件。不含任何业务判断。
 * 各引擎只需要提供一张「命令 → 处理器」表。
 */

import type { AsrStage } from '../engine'
import type { WorkerCommand, WorkerEvent } from './protocol'

/** 命令处理器表：命令种类 → 处理函数（返回值即应答载荷） */
export type WorkerHandlers = Record<string, (payload: unknown) => unknown | Promise<unknown>>

export interface WorkerRuntimeOptions {
  /** 日志前缀（如 'llama-ffi'） */
  label: string
  /**
   * 处理器表工厂：拿到「阶段上报」函数后再建表。
   *
   * 阶段上报要能在命令执行过程中随时触发（加载模型时逐段上报），
   * 所以不能在建表时就固定下来，由工厂把它闭包进去。
   */
  createHandlers: (reportStage: (stage: AsrStage) => void) => WorkerHandlers
  /** 父进程断开时的清理（释放原生资源，避免留下占显存的孤儿） */
  onDispose?: () => void
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 启动 worker 事件循环（进程内阻塞，直到父进程断开）。
 */
export function runFfiWorker(options: WorkerRuntimeOptions): void {
  const { label, createHandlers, onDispose } = options

  const send = (event: WorkerEvent): void => {
    process.send?.(event)
  }

  const reportStage = (stage: AsrStage): void => {
    send({ kind: 'stage', stage })
  }

  const handlers = createHandlers(reportStage)

  process.on('message', (cmd: WorkerCommand) => {
    void (async () => {
      const handler = handlers[cmd.kind]
      if (!handler) {
        send({ kind: 'reply', id: cmd.id, ok: false, error: `未知命令: ${cmd.kind}` })
        return
      }
      try {
        const payload = await handler(cmd.payload)
        send({ kind: 'reply', id: cmd.id, ok: true, payload: payload ?? null })
      } catch (err) {
        // 完整堆栈留在 worker 的 stderr（诊断用），主进程只拿到一句人话
        console.error(`[${label}] 命令失败:`, err)
        send({ kind: 'reply', id: cmd.id, ok: false, error: errorText(err) })
      }
    })()
  })

  // 父进程退出 → 跟着退出（避免留下占显存的孤儿）
  process.on('disconnect', () => {
    try {
      onDispose?.()
    } catch (err) {
      console.error(`[${label}] 清理失败:`, err)
    }
    process.exit(0)
  })
}
