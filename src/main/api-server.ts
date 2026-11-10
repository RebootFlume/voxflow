/**
 * HTTP API Server（OpenAI 兼容 ASR/TTS 端点）
 * —— 对齐 Rust 版 `src-tauri/src/api_server.rs`（Rust 用 tiny_http，这里用 node:http）。
 *
 * 提供：
 * - `GET  /health`
 * - `POST /v1/audio/transcriptions`（ASR）
 * - `POST /v1/audio/speech`（TTS）
 *
 * 语义要点（与 Rust 版一致）：
 * - 鉴权在读 body 之前做（避免不必要的 IO）；api_key 为空则不鉴权
 * - ASR 支持任意长度音频（内部按 60s 分段）
 * - TTS 与 UI 侧共用同一条合成实现；UI 合成期间返回 503（TTS engine busy）
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { log } from './core/logger'
import { decodeAny, ffmpegAvailable } from './audio'
import { decodeWav } from './audio/wav'
import { registry } from './inference/registry'
import { transcribeLong } from './inference/transcribe'
import { splitText, MAX_CHARS_PER_CHUNK } from '@shared/tts-chunk'
import { wavHeader } from './tts/wav-writer'
import { ttsRegistry } from './tts/registry'

export interface ApiConfig {
  host: string
  port: number
  apiKey: string
}

/** 运行中的服务 */
interface RunningServer {
  server: Server
  shutdown: boolean
}

let running: RunningServer | null = null

/** TTS 合成进行中标志（UI 侧合成时 HTTP 请求返回 503，对齐 Rust 的 try_lock 语义） */
let ttsBusy = false

/** 标记 TTS 忙 */
export function setTtsBusy(v: boolean): void {
  ttsBusy = v
}

/** 启动 API 服务 */
export function start(cfg: ApiConfig): void {
  if (running) throw new Error('API service already running')

  const server = createServer((req, res) => {
    void handleRequest(req, res, cfg)
  })

  server.on('error', (e) => {
    log.error(`[api] 服务错误: ${e.message}`)
    running = null
  })

  server.listen(cfg.port, cfg.host, () => {
    running = { server, shutdown: false }
    log.info(`[api] OpenAI 兼容接口已启动: http://${cfg.host}:${cfg.port}`)
  })
}

/** 停止 API 服务 */
export function stop(): boolean {
  if (!running) return false
  const rs = running
  running = null
  rs.shutdown = true
  rs.server.close(() => log.info('[api] OpenAI 兼容接口已停止'))
  rs.server.closeAllConnections?.()
  return true
}

/** 服务是否在运行 */
export function isRunning(): boolean {
  return running !== null
}

// ─── 请求处理 ────────────────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse, cfg: ApiConfig): Promise<void> {
  // 鉴权（在读 body 之前检查，避免不必要的 IO）
  if (!checkAuth(req, cfg.apiKey)) {
    sendJson(res, 401, {
      error: { code: 401, message: 'invalid or missing API key', type: 'invalid_request_error' }
    })
    return
  }

  const method = (req.method ?? 'GET').toUpperCase()
  const url = req.url ?? ''

  if (method === 'GET' && url === '/health') {
    sendJson(res, 200, { status: 'ok' })
    return
  }

  if (method === 'POST' && url === '/v1/audio/transcriptions') {
    const body = await readBody(req)
    const contentType = String(req.headers['content-type'] ?? '')
    await handleAsr(res, body, contentType)
    return
  }

  if (method === 'POST' && url === '/v1/audio/speech') {
    const body = await readBody(req)
    await handleTts(res, body)
    return
  }

  sendJson(res, 404, errorJson(404, 'Not Found'))
}

function checkAuth(req: IncomingMessage, apiKey: string): boolean {
  if (!apiKey) return true
  const auth = req.headers.authorization
  return auth === `Bearer ${apiKey}`
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks)
}

// ─── ASR ────────────────────────────────────────────────────────────────────

async function handleAsr(res: ServerResponse, body: Buffer, contentType: string): Promise<void> {
  // 1. 提取 multipart boundary
  const boundary = parseBoundary(contentType)
  if (!boundary) {
    sendJson(res, 400, errorJson(400, 'missing multipart boundary'))
    return
  }

  // 2. 解析 multipart
  let parts: MultipartPart[]
  try {
    parts = parseMultipart(body, boundary)
  } catch (e) {
    sendJson(res, 400, errorJson(400, e instanceof Error ? e.message : String(e)))
    return
  }

  // 3. 找 file part
  const fileEntry = parts.find((p) => p.name === 'file')
  if (!fileEntry || fileEntry.data.length === 0) {
    sendJson(res, 400, errorJson(400, "missing or empty 'file' field"))
    return
  }
  const filename = fileEntry.filename ?? ''

  // 4. 解码音频
  let samples: Float32Array
  let sampleRate: number
  try {
    if (isWav(fileEntry.data)) {
      // WAV → 内存解码（不写临时文件）
      const r = decodeWav(fileEntry.data)
      samples = r.samples
      sampleRate = r.sampleRate
    } else {
      // 非 WAV（MP3/FLAC 等）→ ffmpeg 子进程
      if (!(await ffmpegAvailable())) {
        sendJson(res, 415, errorJson(415, 'unsupported format (ffmpeg not available)'))
        return
      }
      const ext = extname(filename).replace(/^\./, '') || 'bin'
      const tmp = join(tmpdir(), `voxflow_api_upload.${ext}`)
      writeFileSync(tmp, fileEntry.data)
      try {
        const r = await decodeAny(tmp)
        samples = r.samples
        sampleRate = r.sampleRate
      } catch (e) {
        sendJson(res, 500, errorJson(500, e instanceof Error ? e.message : String(e)))
        return
      } finally {
        rmSync(tmp, { force: true })
      }
    }
  } catch (e) {
    sendJson(res, 500, errorJson(500, e instanceof Error ? e.message : String(e)))
    return
  }

  // 5. 空采样 → 直接返回空文本
  if (samples.length === 0) {
    sendJson(res, 200, { text: '' })
    return
  }

  // 6. 引擎就绪：复用当前已加载引擎（任意框架）；无则按用户上次选择加载
  const reg = registry()
  try {
    if (!reg.activeEngine()) {
      await reg.loadRequestedAsr(() => {})
    }
  } catch (e) {
    sendJson(
      res,
      500,
      errorJson(500, `ASR engine load failed: ${e instanceof Error ? e.message : String(e)}`)
    )
    return
  }
  const engine = reg.activeEngine()
  if (!engine) {
    sendJson(res, 500, errorJson(500, 'ASR engine load failed: no engine available'))
    return
  }

  // 7. 转写（长音频按 60s 分段：外部客户端可 POST 任意长度音频）
  try {
    const text = await transcribeLong(engine, samples, sampleRate, () => {})
    sendJson(res, 200, { text })
  } catch (e) {
    sendJson(
      res,
      500,
      errorJson(500, `transcription failed: ${e instanceof Error ? e.message : String(e)}`)
    )
  }
}

// ─── TTS ────────────────────────────────────────────────────────────────────

async function handleTts(res: ServerResponse, body: Buffer): Promise<void> {
  // 1. 解析 JSON body
  let payload: { input?: unknown; voice?: unknown }
  try {
    payload = JSON.parse(body.toString('utf-8')) as { input?: unknown; voice?: unknown }
  } catch {
    sendJson(res, 400, errorJson(400, 'invalid JSON'))
    return
  }

  const input = typeof payload.input === 'string' ? payload.input : ''
  if (!input) {
    sendJson(res, 400, errorJson(400, "missing or empty 'input' field"))
    return
  }
  const voice = typeof payload.voice === 'string' ? payload.voice : 'default'

  // 2. 合成（采样率取引擎真实输出）；UI 合成期间 → 503
  if (ttsBusy) {
    sendJson(res, 503, errorJson(503, 'TTS engine busy'))
    return
  }
  const tts = ttsRegistry()
  const engine = tts.active()
  if (!engine) {
    sendJson(res, 500, errorJson(500, 'TTS model not loaded'))
    return
  }

  // 与 UI 侧同一条实现（长文本分段）；HTTP 侧无取消入口 ⇒ 一次性令牌（恒不取消）
  const chunks = splitText(input, MAX_CHARS_PER_CHUNK)
  if (chunks.length === 0) {
    sendJson(res, 400, errorJson(400, 'empty text'))
    return
  }

  // 边合成边发：不攒内存，也不攒响应体。
  // 以前是 `Int16Array[] → merged → wavFromI16` 全量驻留，长文本必然 OOM ——
  // 音频总长 × 3 倍内存（分段数组 + 合并数组 + 编码 Buffer）。
  // 流式之后内存只有「当前一段」，客户端也能边收边播。
  //
  // 头必须等第一段合成完才能发：采样率要由引擎真实输出决定，
  // 事前猜一个会把整条流的速率写错（听上去全部变调）。代价只是首字节晚一段的时间。
  // 客户端中途挂断：继续合成只是白烧 GPU，而且 drain 永远不会再来。
  let aborted = false
  res.on('close', () => {
    if (!res.writableEnded) aborted = true
  })

  try {
    let headerSent = false
    for (const part of chunks) {
      if (aborted) {
        log.info(`[api] TTS 客户端已断开，中止剩余分段`)
        return
      }
      const audio = await engine.synthesize(part, voice)
      if (audio.samples.length === 0) continue

      if (!headerSent) {
        // data 段长度未知 ⇒ RIFF 约定用 0xFFFFFFFF（ffmpeg 等按流式处理）
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Transfer-Encoding': 'chunked'
        })
        res.write(wavHeader(0xffffffff, audio.sampleRate))
        headerSent = true
      }
      const ok = res.write(
        Buffer.from(audio.samples.buffer, audio.samples.byteOffset, audio.samples.byteLength)
      )
      // 背压：write 返回 false 表示发送缓冲已满（客户端慢/网络差）。
      // 不等 drain 继续写，Node 会把这个客户端的所有音频攒在内存里 ——
      // 流式写盘省下来的内存又被 HTTP 缓冲吃回去。
      if (!ok) {
        // 同时等 close：客户端断开时 'drain' 永远不会触发，单等它会卡死在这里
        await Promise.race([once(res, 'drain'), once(res, 'close')])
        if (aborted) return
      }
    }

    if (!headerSent) {
      sendJson(res, 500, errorJson(500, 'TTS returned empty audio'))
      return
    }
    if (!aborted) res.end()
  } catch (e) {
    // 头已发出去就不能再改状态码 —— 只能掐断连接，让客户端看到传输不完整
    if (res.headersSent) {
      res.destroy(e instanceof Error ? e : new Error(String(e)))
      return
    }
    sendJson(
      res,
      500,
      errorJson(500, `TTS inference failed: ${e instanceof Error ? e.message : String(e)}`)
    )
  }
}

// ─── 辅助 ────────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text)
  })
  res.end(text)
}

function errorJson(code: number, message: string): Record<string, unknown> {
  return { error: { code, message, type: 'invalid_request_error' } }
}

function isWav(data: Buffer): boolean {
  return data.length >= 4 && data.toString('ascii', 0, 4) === 'RIFF'
}

// ─── Multipart 解析（手写：node:http 无内置 multipart）──────────────────────

interface MultipartPart {
  name: string
  filename: string | null
  data: Buffer
}

/** 从 Content-Type 提取 boundary */
export function parseBoundary(contentType: string): string | null {
  for (const part of contentType.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith('boundary=')) {
      return trimmed.slice('boundary='.length).trim().replace(/^"|"$/g, '')
    }
  }
  return null
}

/**
 * 解析 `multipart/form-data` body。
 * 结构：`--boundary\r\n headers \r\n\r\n data \r\n--boundary[--]`
 *
 * 算法与 Rust 版一致（chunk 切分）：
 *  1. 去掉开头的 `--boundary`
 *  2. 去掉结尾的 `\r\n--boundary--`
 *  3. 反复按 `\r\n--boundary` 切块；**最后一块没有分隔符**（整块即一个 part）
 */
export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const startMarker = Buffer.from(`--${boundary}`)
  const delimiter = Buffer.from(`\r\n--${boundary}`)
  const endMarker = Buffer.from(`\r\n--${boundary}--`)

  let rest = body
  if (rest.subarray(0, startMarker.length).equals(startMarker)) {
    rest = rest.subarray(startMarker.length)
  } else {
    throw new Error('body does not start with boundary')
  }
  const endIdx = rest.indexOf(endMarker)
  if (endIdx >= 0) rest = rest.subarray(0, endIdx)

  const parts: MultipartPart[] = []
  let remaining = rest

  for (;;) {
    const next = remaining.indexOf(delimiter)
    let chunk: Buffer
    if (next >= 0) {
      chunk = remaining.subarray(0, next)
      remaining = remaining.subarray(next + delimiter.length)
    } else {
      chunk = remaining
      remaining = Buffer.alloc(0)
    }

    // 每个 chunk 以 `\r\n` 开头（part 分隔符），去掉
    if (chunk.length >= 2 && chunk.toString('latin1', 0, 2) === '\r\n') {
      chunk = chunk.subarray(2)
    }
    if (chunk.length === 0) {
      if (remaining.length === 0) break
      continue
    }

    // 分离 headers 和 body：`\r\n\r\n` 为分隔符
    const sep = Buffer.from('\r\n\r\n')
    const hdrEnd = chunk.indexOf(sep)
    if (hdrEnd < 0) {
      throw new Error('malformed multipart part: missing header/body separator')
    }
    const headerText = chunk.toString('utf-8', 0, hdrEnd)
    let data = chunk.subarray(hdrEnd + sep.length)
    // 去掉 data 末尾可能的 `\r\n`（boundary 前的换行）
    if (data.length >= 2 && data.toString('latin1', data.length - 2) === '\r\n') {
      data = data.subarray(0, data.length - 2)
    }

    // 解析 Content-Disposition 里的 name / filename
    let name = ''
    let filename: string | null = null
    for (const line of headerText.split('\r\n')) {
      if (!line.toLowerCase().startsWith('content-disposition')) continue
      const nm = /name="([^"]*)"/.exec(line)
      if (nm) name = nm[1]
      const fn = /filename="([^"]*)"/.exec(line)
      if (fn) filename = fn[1]
    }
    if (!name) throw new Error("missing 'name' in Content-Disposition")
    parts.push({ name, filename, data: Buffer.from(data) })

    if (remaining.length === 0) break
  }
  return parts
}

/** 便于外部复用：服务是否监听中 */
export function apiRunning(): boolean {
  return running !== null
}

/** 便捷：检查临时上传文件是否残留（便于自检） */
export function hasLeftoverUpload(): boolean {
  return existsSync(join(tmpdir(), 'voxflow_api_upload.bin'))
}
