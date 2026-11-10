/**
 * `voxflow-audio://` 自定义协议 —— 让 `<audio>` 直接播本地文件。
 *
 * 为什么不用「IPC 读全文件转 Blob」：
 *   1. 有 32MB 上限（24kHz/16bit/mono ≈ 11.6 分钟）。长文本合成的产物动辄几百 MB，
 *      播放按钮会在最需要它的时候报「文件过大」。
 *   2. 整段读进内存 —— 合成端刚用流式写盘把内存问题解决掉，播放端又搬回来一份。
 *   3. `<audio>` 的时间轴拖动需要 Range 请求，Blob 方案只能全量加载后本地 seek，
 *      长音频要先等整个文件读完。
 *
 * 自定义协议对这三点的处理：Chromium 自己分块读盘、按需 seek，
 * 渲染进程内存与音频长度无关。代价是要自己实现 Range（见下）。
 *
 * 安全边界：渲染进程只能拿到我们生成的 URL，但协议 handler 本身可被任意页内
 * JS 调用，所以这里必须自己校验，不能假设调用方守规矩。
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { extname } from 'node:path'
import { protocol } from 'electron'

/**
 * `protocol.handle` 期望的响应类型。
 *
 * 不能直接写 `Response`：electron.d.ts 里 Bluetooth 配对也用了一个叫 `Response`
 * 的接口，它和 DOM 的 `Response` 声明合并了，于是凭空多出一个必填的 `confirmed`
 * 字段（蓝牙配对用的，跟 HTTP 响应毫无关系）。用函数签名反推目标类型，
 * 再在一处做转换，比在每处 return 撒 `as any` 干净。
 */
type ProtocolResponse = Awaited<ReturnType<Parameters<typeof protocol.handle>[1]>>

/** 统一构造响应（唯一做类型转换的地方） */
function makeResponse(
  body: Readable | null,
  status: number,
  headers: Record<string, string>
): ProtocolResponse {
  return new Response(body as unknown as ReadableStream, { status, headers }) as ProtocolResponse
}

/** 协议 scheme（与 index.ts 的 protocol.handle 保持一致） */
export const AUDIO_SCHEME = 'voxflow-audio'

/**
 * 允许播放的扩展名。
 *
 * 白名单而不是黑名单：这个协议能读到用户设的任意导出目录，
 * 没有扩展名限制就等于给了渲染进程一个「读任意文本文件」的通道。
 */
const ALLOWED_EXTS: Record<string, true> = {
  wav: true,
  mp3: true,
  flac: true,
  ogg: true,
  m4a: true,
  aac: true,
  opus: true
}

/** 扩展名 → MIME（`<audio>` 靠它决定用哪个解码器） */
const MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/ogg'
}

/**
 * 文件路径 → 可播放 URL。
 *
 * 用 `encodeURIComponent` 而不是把路径直接拼进 URL：Windows 路径里的
 * 中文、空格、`#`、`?` 都会破坏 URL 解析（`#` 之后被当成 fragment 丢掉，
 * 文件名里带 `#` 的文件会永远 404）。
 */
export function audioUrlFor(filePath: string): string {
  return `${AUDIO_SCHEME}://local/${encodeURIComponent(filePath)}`
}

/** 从 URL 还原文件路径（`voxflow-audio://local/<encoded>`） */
function pathFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    // host 固定为 local，路径部分是被编码的绝对路径
    const raw = decodeURIComponent(u.pathname.replace(/^\//, ''))
    return raw || null
  } catch {
    return null
  }
}

/** 构造 416（Range 不满足） */
function rangeNotSatisfiable(size: number): ProtocolResponse {
  return makeResponse(null, 416, { 'Content-Range': `bytes */${size}` })
}

/**
 * 处理一次音频请求。
 *
 * 实现了 Range（206）：`<audio>` 拖进度条时 Chromium 发 `Range: bytes=N-`，
 * 不回 206 的话无法 seek —— 长音频只能从头听，这个功能就没意义了。
 */
export async function serveAudioRequest(request: Request): Promise<ProtocolResponse> {
  const filePath = pathFromUrl(request.url)
  if (!filePath) return makeResponse(null, 400, {})

  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  if (ALLOWED_EXTS[ext] !== true) return makeResponse(null, 415, {})
  if (!existsSync(filePath)) return makeResponse(null, 404, {})

  const size = statSync(filePath).size
  const mime = MIME[ext] ?? 'application/octet-stream'
  const range = request.headers.get('Range')

  // 无 Range：整段返回。Chromium 对 <audio> 基本都带 Range，
  // 这条路主要是给 curl / 直接访问留的。
  if (!range) {
    return makeResponse(createReadStream(filePath), 200, {
      'Content-Type': mime,
      'Content-Length': String(size),
      // 支持后续 seek
      'Accept-Ranges': 'bytes'
    })
  }

  // 只处理 `bytes=a-b` / `bytes=a-` / `bytes=-n` 三种形式（浏览器只会发这些）
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (!m) return rangeNotSatisfiable(size)

  const startRaw = m[1]
  const endRaw = m[2]
  let start: number
  let end: number
  if (startRaw === '') {
    // `bytes=-N`：最后 N 字节
    const n = Number(endRaw)
    if (!Number.isFinite(n) || n <= 0) return rangeNotSatisfiable(size)
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(startRaw)
    end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return rangeNotSatisfiable(size)
  }

  return makeResponse(createReadStream(filePath, { start, end }), 206, {
    'Content-Type': mime,
    'Content-Length': String(end - start + 1),
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes'
  })
}
