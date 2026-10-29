/**
 * PyTorch Python worker 客户端
 * —— 对齐 Rust 版 `src-tauri/src/inference/pytorch.rs`。
 *
 * 协议：逐行 JSON（stdin 写、stdout 读）
 *   请求 `{ id, method, params }`
 *   响应 `{ id, ok, protocol, result }` 或 `{ id, ok, protocol, error: { kind, message } }`
 *
 * 设计要点（与 Rust 版一致）：
 * - **懒启动**：`new` 只解析运行时目录，进程在第一次 `call` 时才拉起
 * - **崩溃自愈**：进程退出后下一次 `call` 自动重启（上层无感，但已加载的模型会丢，
 *   因此引擎层必须在重启后重新 `load_model`）
 * - **只认自己的响应**：id 不符（含运行时主动上报）的行不消费给本请求
 * - **非协议输出**（第三方库直接 print）不当成响应，继续等
 * - **超时/报错都带 stderr 尾巴**：便于定位 DLL / 驱动问题
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../core/logger'
import { installedRuntimeForDevice, runtimeDirFor } from './runtime-download'

/** 协议版本（与 worker.py 的 PROTOCOL_VERSION 对齐） */
export const PROTOCOL_VERSION = 1

/** 普通请求超时（ping / 已加载模型的命令） */
const REQUEST_TIMEOUT_MS = 30_000
/** 冷启动超时：首次 `import torch` + 初始化 CUDA 在机械盘/低端机可能超过 30s */
const WARMUP_TIMEOUT_MS = 180_000
/** 模型加载超时（读权重 + 建 module；CUDA 首次分配可能较慢） */
const MODEL_LOAD_TIMEOUT_MS = 600_000
/** 单次推理超时（转写/合成；长音频由上层分段，这里留足余量） */
const INFERENCE_TIMEOUT_MS = 600_000
/** stderr 保留的最大字节数（只留尾部用于报错） */
const STDERR_TAIL_LIMIT = 8 * 1024

/** 一次请求的原始响应 */
interface Reply {
  ok: boolean
  result: Record<string, unknown>
  errorKind: string
  errorMessage: string
}

/** 运行中的 worker */
interface Running {
  child: ChildProcessWithoutNullStreams
  lines: AsyncIterableIterator<string>
  stderrTail: string
  exited: boolean
}

/** 待响应的请求 */
interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** 方法名（错误文案用） */
  method: string
}

/** 设备是否指 CUDA */
export function isCuda(device: string): boolean {
  const d = device.trim().toLowerCase()
  return d === 'cuda' || d === 'gpu'
}

/**
 * 运行时目录解析器覆盖（**测试用**；生产走已安装包解析）。
 *
 * 存在的原因：PyTorch 运行时包自带嵌入式 Python，测试机通常没装该包，
 * 于是无法构造 worker。覆盖后可用「假 worker.py + 真解释器」验证
 * 协议握手、超时、崩溃、协议不符等路径（对齐 Rust 版的 `with_dir` 测试钩子）。
 */
let runtimeDirResolver: ((device: string) => string) | null = null

/** 覆盖运行时目录解析（传 null 恢复默认） */
export function overrideRuntimeDirResolver(fn: ((device: string) => string) | null): void {
  runtimeDirResolver = fn
}

/**
 * 长驻 worker 句柄。
 *
 * 懒启动：`new` 只解析运行时目录，真正的进程在第一次 `call` 时拉起。
 */
export class PyTorchWorker {
  private dir: string
  private device: string
  private running: Running | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()

  /**
   * 按设备解析运行时并创建句柄（不启动进程）。
   *
   * `device`: "cpu" 或 "cuda"。CUDA 包在设备能力上覆盖 CPU，因此 CUDA 请求
   * 只接受 `supports_cuda` 的包，CPU 请求优先复用已安装的 CUDA 包。
   */
  constructor(device: string) {
    if (runtimeDirResolver) {
      this.dir = runtimeDirResolver(device)
      this.device = isCuda(device) ? 'cuda' : 'cpu'
      return
    }
    const pkg = installedRuntimeForDevice('pytorch', device)
    if (!pkg) {
      const want = isCuda(device) ? 'CUDA' : 'CPU'
      throw new Error(`PyTorch ${want} 运行时未安装：请先在「推理框架」页下载对应运行时包`)
    }
    this.dir = runtimeDirFor(pkg)
    this.device = isCuda(device) ? 'cuda' : 'cpu'
  }

  /** 运行时目录（libs/pytorch-<variant>） */
  runtimeDir(): string {
    return this.dir
  }

  /** 目标设备（cpu / cuda） */
  deviceName(): string {
    return this.device
  }

  /** worker 子进程 PID（未启动或已退出 → None）。显存监控按 PID 取真值用。 */
  pid(): number | null {
    const running = this.running
    if (!running || running.exited) return null
    return running.child.pid ?? null
  }

  /** 进程当前是否存活 */
  isRunning(): boolean {
    return this.pid() !== null
  }

  /** stderr 尾部（报错附带上，便于定位 DLL / 驱动问题） */
  stderrTail(): string {
    return this.running?.stderrTail ?? ''
  }

  /**
   * 查询运行时信息：Python / torch 版本、CUDA 是否可用、设备数。
   *
   * 这是"设备是否真的能用"的唯一判据：装了 CUDA 包但驱动不兼容时，
   * `cuda_available` 为 false —— 上层据此决定是否回退 CPU 或报错。
   */
  async runtimeInfo(): Promise<Record<string, unknown>> {
    return this.call('runtime_info', {}, WARMUP_TIMEOUT_MS)
  }

  /** 探活（不加载模型，不初始化 CUDA） */
  async ping(): Promise<void> {
    await this.call('ping', {}, REQUEST_TIMEOUT_MS)
  }

  /**
   * 加载模型。
   *
   * `adapter` 必须是运行时内置白名单里的 id（worker 会拒绝其它值）；
   * 模型目录只提供权重与配置，不携带可执行代码。
   */
  async loadModel(
    modelDir: string,
    adapter: string,
    language: string,
    voice: string
  ): Promise<Record<string, unknown>> {
    return this.call(
      'load_model',
      {
        model_dir: modelDir,
        adapter,
        device: this.device,
        options: { language, voice }
      },
      MODEL_LOAD_TIMEOUT_MS
    )
  }

  /** 卸载模型（保留 worker 进程；换模型/换设备由调用方决定是否 `shutdown`） */
  async unloadModel(): Promise<Record<string, unknown>> {
    return this.call('unload_model', {}, REQUEST_TIMEOUT_MS)
  }

  /** 转写：音频以临时 WAV 路径传入（`options` 透传给适配器：language / context） */
  async transcribe(wav: string, options: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call('transcribe', { wav, options }, INFERENCE_TIMEOUT_MS)
  }

  /** 合成：worker 直接写出 WAV（`options`: voice / speed / language） */
  async synthesize(
    text: string,
    outWav: string,
    options: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.call('synthesize', { text, out_wav: outWav, options }, INFERENCE_TIMEOUT_MS)
  }

  /** 请求 worker 退出；随后强制回收，避免残留进程占着 DLL。 */
  async shutdown(): Promise<void> {
    try {
      await this.call('shutdown', {}, 5000)
    } catch {
      // worker 可能已经死了：忽略，走 kill
    }
    this.kill()
  }

  /** 立即结束子进程 */
  kill(): void {
    const running = this.running
    this.running = null
    if (!running) return
    running.exited = true
    // 取消所有在途请求（进程没了，不会再有响应）
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('worker 已退出'))
    }
    this.pending.clear()
    try {
      running.child.kill()
    } catch {
      /* 已退出 */
    }
  }

  /** 发一条请求并等响应（含懒启动、崩溃重启、超时诊断） */
  private async call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++
    this.ensureRunning()

    const running = this.running
    if (!running) throw new Error('worker 启动失败')

    const line = JSON.stringify({ id, method, params })
    try {
      running.child.stdin.write(`${line}\n`)
    } catch (e) {
      throw new Error(`worker 写入失败: ${e instanceof Error ? e.message : String(e)}`)
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const tail = this.stderrTail()
        reject(
          new Error(
            `worker 超时（${method}，${Math.round(timeoutMs / 1000)}s）${
              tail ? `；stderr: ${tail}` : ''
            }`
          )
        )
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer, method })
    })
  }

  /** 确保进程存活：未启动 → 拉起；已退出 → 重启（并清空旧管道） */
  private ensureRunning(): void {
    if (this.running && !this.running.exited) return
    if (this.running) {
      log.warn(`[pytorch] worker 已退出，将重启：${this.running.stderrTail}`)
    }
    this.running = this.spawn()
  }

  /** 启动 `python.exe worker.py`（工作目录 = 运行时目录，隐藏控制台） */
  private spawn(): Running {
    const exe = join(this.dir, process.platform === 'win32' ? 'python.exe' : 'python')
    if (!existsSync(exe)) {
      throw new Error(`PyTorch 运行时缺少 ${exe}：请重新下载运行时包`)
    }
    const script = join(this.dir, 'worker.py')
    if (!existsSync(script)) {
      throw new Error(`PyTorch 运行时缺少 ${script}：请重新下载运行时包`)
    }

    const child = spawn(exe, ['worker.py'], {
      cwd: this.dir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        VOXFLOW_DEVICE: this.device
      }
    }) as ChildProcessWithoutNullStreams

    const running: Running = {
      child,
      lines: createInterface({ input: child.stdout })[Symbol.asyncIterator](),
      stderrTail: '',
      exited: false
    }

    // stdout：逐行读 → 按 id 分发给在途请求
    void (async () => {
      try {
        for await (const line of running.lines) {
          this.handleLine(line)
        }
      } catch {
        /* 流关闭 */
      }
      running.exited = true
      // 进程结束 → 所有在途请求失败
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`worker 已退出（${p.method}）${this.stderrTail()}`))
      }
      this.pending.clear()
    })()

    // stderr：排水 + 保留尾部（防管道写满阻塞 worker）
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      let buf = running.stderrTail + text
      if (buf.length > STDERR_TAIL_LIMIT) {
        const cut = buf.length - STDERR_TAIL_LIMIT
        buf = buf.slice(cut)
      }
      running.stderrTail = buf
    })

    child.on('exit', (code) => {
      running.exited = true
      log.warn(`[pytorch] worker 退出（code=${code}）`)
    })
    child.on('error', (e) => {
      running.exited = true
      log.error(`[pytorch] worker 进程错误: ${e.message}`)
    })

    log.info(`[pytorch] worker 启动：${exe} worker.py（device=${this.device}，pid=${child.pid}）`)
    return running
  }

  /** 处理 worker 的一行输出 */
  private handleLine(line: string): void {
    const text = line.trim()
    if (!text) return
    let value: Record<string, unknown>
    try {
      value = JSON.parse(text) as Record<string, unknown>
    } catch {
      // 非协议输出（例如第三方库直接 print）不当作响应，继续等
      return
    }
    const replyId = typeof value.id === 'number' ? value.id : undefined
    if (replyId === undefined) return
    // 只认自己的响应：id 不符（含运行时主动上报）不消费给本请求
    const p = this.pending.get(replyId)
    if (!p) return

    let reply: Reply
    try {
      reply = parseReply(value)
    } catch (e) {
      // 协议版本不符等解析错误：只让**本请求**失败，不能连累整个 worker
      this.pending.delete(replyId)
      clearTimeout(p.timer)
      p.reject(e instanceof Error ? e : new Error(String(e)))
      return
    }

    this.pending.delete(replyId)
    clearTimeout(p.timer)

    if (reply.ok) {
      p.resolve(reply.result)
    } else {
      const tail = this.stderrTail()
      p.reject(
        new Error(
          `worker 返回错误（${reply.errorKind}: ${reply.errorMessage}）${tail ? `；stderr: ${tail}` : ''}`
        )
      )
    }
  }
}

/** 解析响应；协议版本不符视为协议错误（不静默按旧版解释） */
export function parseReply(value: Record<string, unknown>): Reply {
  const protocol = typeof value.protocol === 'number' ? value.protocol : undefined
  if (protocol !== PROTOCOL_VERSION) {
    throw new Error(
      `worker 协议版本不符：期望 ${PROTOCOL_VERSION}，实际 ${String(protocol)}（请更新运行时包）`
    )
  }
  const ok = value.ok === true
  const error = (value.error ?? {}) as Record<string, unknown>
  return {
    ok,
    result: (value.result ?? {}) as Record<string, unknown>,
    errorKind: typeof error.kind === 'string' ? error.kind : '',
    errorMessage: typeof error.message === 'string' ? error.message : ''
  }
}

/**
 * 一次性设备探测：拉起 worker → `runtime_info` → 关闭。
 *
 * 供「推理框架」页展示"CUDA 是否真的可用"（装了包 ≠ 驱动能用）。
 */
export async function probeDevice(device: string): Promise<Record<string, unknown>> {
  const worker = new PyTorchWorker(device)
  try {
    return await worker.runtimeInfo()
  } finally {
    await worker.shutdown()
  }
}
