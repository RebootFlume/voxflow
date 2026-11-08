/**
 * 全局单实例（跨数据根 / 跨安装形态）。
 *
 * 为什么必须单实例（而不是"按数据根各开各的"）：
 * 冲突的根源不是配置文件，而是**全局资源**：
 *   - 全局热键（uIOhook 是系统级钩子）→ 两个实例都会收到按键 → 两次录音、两次上屏、互相抢剪贴板
 *   - 固定端口（sherpa-asr 9002）→ 第二个实例启动引擎时，
 *     端口守卫（`inference/device.ts` killPortOwner）会把"路径在本软件 libs 下"的进程当成
 *     自己的残留杀掉 —— 也就是**第二个实例会去杀第一个实例正在用的引擎**
 *   - 显存 / 托盘 / 历史记录 → 双份占用、双份写入
 * 所以这里用**全局**单实例：便携版与安装版也算同一个应用。
 *
 * 机制选择：控制端口 + 唤起协议（而不是锁文件）。
 *   - 端口由操作系统回收：主进程被强杀/崩溃后端口自动释放，不会留下"死锁残留"
 *     （锁文件方案必须额外做 PID 存活校验 + 竞态处理）
 *   - 第二实例的诉求只有一个——"把我的窗口叫出来"，正好可以复用这条通道
 *   - 不使用 Electron 内置的 `app.requestSingleInstanceLock()`：它按 **userData 目录**
 *     判定（package.json name=voxflow → `%APPDATA%\voxflow`），而我们的数据根是
 *     `%APPDATA%\com.voxflow.app`（`core/data-root.ts`），两者对不上，
 *     而且它挡不住"便携版 + 安装版"并存。
 *
 * 协议：一行 JSON + 换行。
 *   请求 `{"magic":"voxflow-control/1","action":"show"}`
 *   应答 `{"magic":"voxflow-control/1","ok":true}`
 * 魔数用来确认对面确实是 VoxFlow —— 端口被别的程序占用时不能误判成"已有实例"。
 */

import { connect, createServer, type Server, type Socket } from 'node:net'
import { log } from './logger'

/** 控制端口候选（避开引擎端口 8931 / 9002；第一个被别的程序占了就换下一个） */
export const CONTROL_PORTS = [8930, 8940, 8950]

/** 握手魔数：确认对面是 VoxFlow 主实例 */
export const CONTROL_MAGIC = 'voxflow-control/1'

/** 开发调试用：置 1 时跳过单实例约束（多开调试 / 自动化测试） */
export const ALLOW_MULTI_ENV = 'VOXFLOW_ALLOW_MULTI'

/**
 * 最近一次单实例判定结果。
 * 主进程日志走 sidecar 事件，而渲染进程就绪前发出的事件会丢 →
 * 所以判定结果同时存一份，供渲染进程启动时主动来查（写进运行日志）。
 */
let lastInstanceInfo: { isPrimary: boolean; status: string } = { isPrimary: true, status: '尚未判定' }

/** 查询单实例判定结果（IPC 用） */
export function instanceInfo(): { isPrimary: boolean; status: string } {
  return { ...lastInstanceInfo }
}

/** 记录判定结果并返回 */
function finish(
  result: { isPrimary: boolean; status: string },
  close?: () => void
): SingleInstanceHandle {
  lastInstanceInfo = { ...result }
  return { ...result, close: close ?? (() => {}) }
}

interface ControlMessage {
  magic?: string
  action?: string
  ok?: boolean
}

export interface SingleInstanceHandle {
  /** true = 主实例；false = 第二个实例（已通知主实例唤起窗口，本进程应立即退出） */
  isPrimary: boolean
  /**
   * 单实例判定结果的人话描述。
   * 注意：`log.info` 走 sidecar 事件，渲染进程还没起来时事件会丢 →
   * 由调用方在建好窗口后补一条日志（用这个字段）。
   */
  status: string
  /** 主实例：关闭控制通道（退出前调用） */
  close(): void
}

/** 读一条以 \n 结尾的 JSON 消息（超时/解析失败 → null） */
function readMessage(socket: Socket, timeoutMs: number): Promise<ControlMessage | null> {
  return new Promise((resolve) => {
    let buf = ''
    let settled = false
    const finish = (msg: ControlMessage | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 注意：这里**不能** destroy socket —— 服务端读完消息后还要 socket.end(应答) 回话，
      // 提前销毁会让应答写不进去（客户端只收到 FIN、零字节）→ 单实例握手永远失败，
      // 第二个实例会误判"端口被别的程序占用"，把自己升级成第二个主实例。
      // socket 的收尾交给调用方。
      resolve(msg)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    socket.setEncoding('utf-8')
    socket.on('data', (chunk: string) => {
      buf += chunk
      const idx = buf.indexOf('\n')
      if (idx < 0) return
      const line = buf.slice(0, idx)
      try {
        finish(JSON.parse(line) as ControlMessage)
      } catch {
        finish(null)
      }
    })
    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))
  })
}

/** 启动控制通道；端口被占 → resolve(null) */
function startControlServer(port: number, onShow: () => void): Promise<Server | null> {
  return new Promise((resolve) => {
    let settled = false
    const server = createServer((socket) => {
      // 客户端随时可能断开；socket 的错误必须被吃掉，否则会变成未捕获异常
      socket.on('error', () => {
        /* 对端断开 */
      })
      void (async () => {
        const reply = (text: string): void => {
          try {
            socket.end(text)
          } catch {
            /* 已断开 */
          }
        }
        const msg = await readMessage(socket, 2000)
        if (!msg || msg.magic !== CONTROL_MAGIC) {
          reply('{}\n')
          return
        }
        if (msg.action === 'show') {
          // 此时渲染进程通常已经连上 → 这条日志能落进应用日志文件
          log.info('[single-instance] 收到第二个实例的唤起请求 → 显示主窗口')
          try {
            onShow()
          } catch (e) {
            log.warn(`[single-instance] 唤起主窗口失败: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        reply(`${JSON.stringify({ magic: CONTROL_MAGIC, ok: true })}\n`)
      })()
    })
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) {
        log.warn(`[single-instance] 控制端口 ${port} 发生错误: ${err.message}`)
        return
      }
      settled = true
      // EADDRINUSE = 端口被别人占着（可能是另一个 VoxFlow 实例，也可能是别的程序）
      resolve(null)
    })
    server.listen(port, '127.0.0.1', () => {
      if (settled) return
      settled = true
      resolve(server)
    })
  })
}

/**
 * 向控制端口发「显示窗口」请求。
 * 返回 true = 对面确实是 VoxFlow 主实例（已受理请求）；false = 不是（超时/魔数不符）。
 */
function requestShow(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        /* 已断开 */
      }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.on('error', () => finish(false))
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ magic: CONTROL_MAGIC, action: 'show' })}\n`)
    })
    let buf = ''
    socket.setEncoding('utf-8')
    socket.on('data', (chunk: string) => {
      buf += chunk
      const idx = buf.indexOf('\n')
      if (idx < 0) return
      try {
        const msg = JSON.parse(buf.slice(0, idx)) as ControlMessage
        finish(msg.magic === CONTROL_MAGIC)
      } catch {
        finish(false)
      }
    })
  })
}

/**
 * 申请成为主实例。
 *
 * - 拿到控制端口 → 主实例
 * - 端口被占且对面是 VoxFlow → 第二实例（已请求唤起主窗口），调用方应立即退出
 * - 所有候选端口都被别的程序占着 → 降级为多实例（只记警告，不阻塞启动）
 */
export async function ensureSingleInstance(opts: {
  /** 主实例收到「显示窗口」请求时的回调 */
  onShow: () => void
}): Promise<SingleInstanceHandle> {
  if (process.env[ALLOW_MULTI_ENV] === '1') {
    log.warn(`[single-instance] ${ALLOW_MULTI_ENV}=1，跳过单实例约束（仅供开发调试）`)
    return finish({ isPrimary: true, status: `已跳过单实例约束（${ALLOW_MULTI_ENV}=1）` })
  }

  for (const port of CONTROL_PORTS) {
    const server = await startControlServer(port, opts.onShow)
    if (server) {
      log.info(`[single-instance] 主实例已就绪（控制端口 ${port}）`)
      return finish({ isPrimary: true, status: `主实例（控制端口 ${port}）` }, () => {
        try {
          server.close()
        } catch {
          /* 已关闭 */
        }
      })
    }

    // 端口被占：探一下对面是不是 VoxFlow 主实例
    if (await requestShow(port)) {
      log.info(`[single-instance] 已有实例在运行（控制端口 ${port}），已请求唤起主窗口`)
      return finish({ isPrimary: false, status: `第二实例（检测到已有实例，控制端口 ${port}，已请求唤起主窗口）` })
    }
    log.warn(`[single-instance] 控制端口 ${port} 被其它程序占用，换下一个端口`)
  }

  log.warn('[single-instance] 未能占用任何控制端口，降级为多实例模式（可能出现端口/热键冲突）')
  return finish({ isPrimary: true, status: '降级为多实例模式（候选控制端口都被占用，可能出现端口/热键冲突）' })
}
