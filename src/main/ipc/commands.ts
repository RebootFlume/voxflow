/**
 * 主进程命令表 —— 把 Tauri 版的 `#[tauri::command]` 逐条映射为 Electron IPC 命令。
 *
 * 命令名与参数名**完全沿用 Tauri 版**（camelCase 参数），前端 `src/lib/ipc.ts`
 * 因此可以保持原有调用形状，只有桥接层本身需要重写。
 *
 * 事件通道沿用 Tauri 版的两个：
 *  - `sidecar://event`：主总线，payload 用 `status` 判别
 *  - `asr://status`：热键录音状态（裸字符串）
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'path'
import { emitSidecar, emitStatus, nextStatusSeq } from '../core/events'
import { getDataRootInfo, storageModelRoot } from '../core/data-root'
import { instanceInfo } from '../core/single-instance'
import { getDataDir, readDataFile, removeDataFile, writeDataFile } from '../core/persistence'
import { log } from '../core/logger'
import { decodeAny } from '../audio'
import { registry, findModelSpec } from '../inference/registry'
import { llamaEngine } from '../inference/llama-ffi'
import { transcribeFileWithProgress } from '../inference/transcribe-file'
import { getGpuInfo, getVramStatus } from '../inference/vram'
import {
  activeEntryOf,
  adoptProxyEnv,
  checkLoadVram,
  deleteModel,
  emitModelsState,
  listModelsPayload,
  mainModelFile,
  modelDir,
  requestCancel,
  setModelRoot,
  setProxy,
  setToken,
  startDownload
} from '../models/model-manager'
import { runtimeStatus, verifyRuntimeFull, downloadRuntime, requestCancelRuntime } from '../inference/runtime-download'
import { ttsRegistry } from '../tts/registry'
import * as apiServer from '../api-server'
import * as tts from '../tts/commands'
import { setHotkey } from '../system/hotkey'
import { openInExplorer } from '../system/explorer'
import { listAudioDevices } from '../system/audio-devices'

/** 关闭到托盘标志（内存态，持久化由前端 config.json 负责） */
let closeToTray = true

/** 设置关闭窗口的行为：true = 隐藏到托盘继续运行，false = 直接退出 */
export function setCloseToTray(value: boolean): void {
  closeToTray = value
}

/** 当前关闭到托盘标志 */
export function getCloseToTray(): boolean {
  return closeToTray
}

/** 统一 ASR 加载请求号：前端用它丢弃旧请求的迟到事件 */
let nextAsrReq = 0

/** 命令处理函数签名 */
type CommandHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>

/** 读取字符串参数 */
function str(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key]
  return typeof v === 'string' ? v : fallback
}

/** 读取布尔参数 */
function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key]
  return typeof v === 'boolean' ? v : fallback
}

/** 读取可选字符串参数 */
function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' ? v : undefined
}

/** 发一条 error 事件（对应 Rust 的 emit_error） */
function emitError(msg: string): void {
  emitStatus('error', { msg })
}

/**
 * 侧车动作分发 —— 对齐 Rust 版 `lib.rs::dispatch_sidecar_action`。
 * 协议与原 Python sidecar 一致（action 判别）。
 */
async function dispatchSidecarAction(payload: Record<string, unknown>): Promise<unknown> {
  const action = str(payload, 'action')

  switch (action) {
    case 'bootstrap': {
      const root = optStr(payload, 'model_root')
      if (root && root.trim()) {
        try {
          setModelRoot(root)
        } catch {
          /* 非法路径忽略，bootstrap 不阻断 */
        }
      }
      const proxy = optStr(payload, 'proxy')
      if (proxy !== undefined) setProxy(proxy)
      // 代理单一来源：配置为空则接管 env（对齐 Rust 版 bootstrap 的 adopt_proxy_env）
      const effective = adoptProxyEnv()
      log.info(`[proxy] 生效代理: ${effective === '' ? '(直连)' : effective}`)
      // 单实例判定结果也在这里补一条：bootstrap 是渲染进程启动时发的第一条消息，
      // 此时渲染进程已连上 → 这条日志能落进应用日志文件
      // （启动早期直接 log.info 会因为渲染进程还没订阅 sidecar 而丢失）
      log.info(`[single-instance] ${instanceInfo().status}`)
      const token = optStr(payload, 'hf_token')
      if (token !== undefined) setToken(token)
      emitModelsState()
      return { ok: true }
    }

    case 'set_model_root': {
      const path = str(payload, 'path')
      try {
        const resolved = setModelRoot(path)
        emitStatus('model_root_set', { path: resolved })
        emitModelsState()
        return { ok: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        emitError(msg)
        return { status: 'error', msg }
      }
    }

    case 'set_proxy': {
      const normalized = setProxy(str(payload, 'proxy'))
      emitStatus('proxy_set', { proxy: normalized })
      return { ok: true, proxy: normalized }
    }

    case 'set_token': {
      // HF 下载 token：只接收存储，不回显（避免明文泄漏到日志/事件）
      const saved = setToken(str(payload, 'token'))
      emitStatus('token_set', { has_token: saved.length > 0 })
      return { ok: true }
    }

    case 'check_capabilities': {
      // 能力检测：ffmpeg 是否可用（前端 TranscribePanel 依赖此标记决定支持格式）
      const { ffmpegAvailable } = await import('../audio/ffmpeg')
      const ffmpeg = await ffmpegAvailable()
      emitStatus('capabilities', { ffmpeg })
      return { ok: true, ffmpeg }
    }

    case 'list_models': {
      const kind = optStr(payload, 'kind')
      if (kind) {
        emitSidecar(listModelsPayload(kind))
      } else {
        emitModelsState()
      }
      return { ok: true }
    }

    case 'download_model': {
      const name = str(payload, 'model')
      const entry = str(payload, 'entry')
      if (!name) {
        const msg = 'missing model'
        emitError(msg)
        return { status: 'error', msg }
      }
      // 切换条目（目标 != 当前安装）时必须先卸载：Windows 下引擎占用着旧文件
      const spec = findModelSpec(name)
      if (spec && spec.entries.length > 0 && isModelInUse(name)) {
        const active = activeEntryOf(spec)
        const switching = active ? entry.length > 0 && entry !== active.id : false
        if (switching) {
          const msg = `模型正在使用：请先卸载再切换量化（${spec.name}）`
          emitError(msg)
          return { status: 'error', msg }
        }
      }
      try {
        await startDownload(name, entry)
        emitStatus('model_download_started', { model: name })
        emitModelsState()
        return { ok: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        emitError(msg)
        return { status: 'error', msg }
      }
    }

    case 'cancel_download': {
      const name = str(payload, 'model')
      if (!requestCancel(name)) {
        const msg = `no active download: ${name}`
        emitError(msg)
        return { status: 'error', msg }
      }
      return { ok: true }
    }

    case 'delete_model': {
      const name = str(payload, 'model')
      if (isModelInUse(name)) {
        const msg = `model in use: ${name}`
        emitError(msg)
        return { status: 'error', msg }
      }
      try {
        const freed = await deleteModel(name)
        emitStatus('model_deleted', { model: name, freed_bytes: freed })
        emitModelsState()
        return { ok: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        emitError(msg)
        return { status: 'error', msg }
      }
    }

    case 'load_model': {
      const name = str(payload, 'model')
      const device = str(payload, 'device', 'cpu')
      if (!name) {
        const msg = 'missing model'
        emitError(msg)
        return { status: 'error', msg }
      }
      const found = findModelSpec(name)
      emitStatus('model_loading', { model: name, kind: found?.kind ?? '' })
      if (!found) {
        const msg = `unknown model: ${name}`
        emitError(msg)
        return { status: 'error', msg }
      }
      const dir = modelDir(name)
      const mainFile = mainModelFile(found, dir)
      if (!mainFile) {
        const msg = `model file not found for ${name} (framework: ${found.framework})`
        emitStatus('model_not_downloaded', { model: name, msg, kind: found.kind })
        return { status: 'error', msg }
      }
      if (found.kind === 'asr') {
        const prefix = found.backend.type === 'llama' ? 'GGUF 引擎加载失败' : 'sherpa ASR 加载失败'
        try {
          const { model: loadedName } = await registry().loadAsrByName(name, device, () => {})
          emitStatus('model_loaded', { kind: found.kind, model: loadedName, device })
        } catch (e) {
          const msg = `${prefix}: ${e instanceof Error ? e.message : String(e)}`
          log.warn(`[load_model] ASR 加载失败(${found.id}): ${msg}`)
          emitStatus('model_error', { kind: found.kind, model: name, msg })
        }
      } else {
        // TTS → TtsRegistry（按描述符路由）
        try {
          const { framework, model: loadedName } = await tts.loadTtsModel(name, device)
          emitSidecar({
            status: 'model_ready',
            kind: 'tts',
            model: loadedName,
            framework,
            device
          })
        } catch (e) {
          const msg = `TTS load failed: ${e instanceof Error ? e.message : String(e)}`
          emitError(msg)
          emitSidecar({ status: 'model_error', kind: 'tts', model: name, msg })
        }
      }
      return { ok: true }
    }

    case 'start_api': {
      const host = optStr(payload, 'host') ?? '127.0.0.1'
      const port = typeof payload.port === 'number' ? payload.port : 9870
      const apiKey = optStr(payload, 'api_key') ?? ''
      try {
        apiServer.start({ host, port, apiKey })
        emitStatus('api_started', { port })
        return { ok: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        emitError(msg)
        return { status: 'error', msg }
      }
    }

    case 'stop_api': {
      apiServer.stop()
      emitStatus('api_stopped')
      return { ok: true }
    }

    default:
      // 其它 action：与 Rust 版一致，返回 ok
      return { ok: true }
  }
}

/** 模型是否使用中：按描述符 kind 判定对应引擎 */
function isModelInUse(name: string): boolean {
  const spec = findModelSpec(name)
  if (!spec) return false
  if (spec.kind === 'asr') {
    const engine = registry().activeEngine()
    return engine ? engine.currentModel() === name : false
  }
  if (spec.kind === 'tts') {
    // Rust 版是「TTS 引擎一加载就全挡住」（src-tauri/src/lib.rs:58-70），
    // 这里做得更精确一点：TTS 引擎的模型目录是**按 spec** 组织的
    // （src/main/tts/registry.ts:121 modelDir(specId)），所以只有**同一个 spec**
    // 的模型才真的被引擎占用，别的 spec 可以安全删除。
    const loaded = ttsRegistry().loadedModel()
    if (!loaded) return false
    if (loaded === name) return true
    const loadedSpec = findModelSpec(loaded)
    return !!loadedSpec && loadedSpec.id === spec.id
  }
  return false
}

/**
 * 命令表：命令名 → 处理函数。
 * 未在此表中的命令会返回「未知命令」错误。
 */
export const commands: Record<string, CommandHandler> = {
  // ── 侧车动作分发 ─────────────────────────────────────────────────────────
  send_to_sidecar_safe: (args) => dispatchSidecarAction(args.payload as Record<string, unknown> ?? {}),

  // ── 热键 / 窗口行为 ──────────────────────────────────────────────────────
  set_hotkey: (args) => {
    setHotkey(str(args, 'hotkey'))
    return null
  },
  rust_set_close_to_tray: (args) => {
    setCloseToTray(bool(args, 'closeToTray', true))
    return null
  },

  // ── 持久化 ───────────────────────────────────────────────────────────────
  read_data_file: (args) => readDataFile(str(args, 'filename')),
  write_data_file: (args) => {
    writeDataFile(str(args, 'filename'), str(args, 'content'))
    return null
  },
  remove_data_file: (args) => {
    removeDataFile(str(args, 'filename'))
    return null
  },
  get_data_dir: () => getDataDir(),
  get_data_root_info: () => getDataRootInfo(),
  // 单实例判定结果（Electron 版新增；Tauri 版没有这个概念）
  get_instance_info: () => instanceInfo(),
  rust_storage_model_root: (args) => storageModelRoot(str(args, 'root')),

  // ── 显存 / GPU ───────────────────────────────────────────────────────────
  get_gpu_info: () => getGpuInfo(),
  get_vram_status: () => getVramStatus(),
  rust_check_vram: (args) => checkLoadVram(str(args, 'name'), str(args, 'device')),

  // ── ASR 引擎 ─────────────────────────────────────────────────────────────
  rust_load_asr: async (args) => {
    const model = str(args, 'model')
    const device = str(args, 'device', 'cuda')
    const req = ++nextAsrReq

    // 注册表权威框架（事件带出，前端据此切换模型页标签，无需猜）
    let framework: string | undefined
    try {
      framework = registry().frameworkForModel(model)
    } catch {
      framework = undefined
    }

    emitSidecar({
      status: 'model_loading',
      reqId: req,
      kind: 'asr',
      model,
      device,
      framework
    })

    // 后台执行 + 终态兜底（立即返回，事件驱动状态）
    void (async () => {
      const started = Date.now()
      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('模型加载超时（240s），已中止并清理残留')), 240_000)
        )
        const load = registry().loadAsrByName(model, device, (stage) => {
          emitSidecar({
            status: 'model_progress',
            reqId: req,
            kind: 'asr',
            model,
            device,
            stage
          })
        })
        const { framework: fw, model: name } = await Promise.race([load, timeout])
        emitSidecar({
          status: 'model_ready',
          reqId: req,
          kind: 'asr',
          model: name,
          device,
          framework: fw,
          load_ms: Date.now() - started
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // 超时兜底：卸载残留引擎，保证下次加载干净
        if (msg.includes('超时')) {
          try {
            await registry().unloadActive()
          } catch {
            /* 忽略 */
          }
        }
        emitSidecar({
          status: 'model_error',
          reqId: req,
          kind: 'asr',
          model,
          device,
          msg
        })
      }
    })()

    return { ok: true, reqId: req, model, loading: true }
  },

  rust_get_status: async () => {
    const llama = await llamaEngine.snapshot()
    const loaded = llama.loaded
    const snap = {
      status: 'status_snapshot',
      seq: nextStatusSeq(),
      asr: {
        loaded,
        model: loaded ? llama.model : '',
        device: loaded ? llama.device : ''
      },
      recording: false
    }
    emitSidecar(snap)
    return snap
  },

  rust_unload_asr: async () => {
    await registry().unloadActive()
    // 双保险：即使 active 判定异常，也把两个引擎都停掉（对齐 Rust 版）
    await llamaEngine.unload()
    // 走注册表卸载：注册表里的 activeFramework 缓存会被一起清掉
    // （直接调 sherpaFfiAdapter.unload() 会把缓存留在 'onnx'）。
    await registry().unload('onnx')
    await registry().unload('audiocpp')
    return { ok: true, loaded: false }
  },

  rust_transcribe_llama: async (args) => {
    const filePath = str(args, 'filePath')
    const exportDir = optStr(args, 'exportDir')
    const exportFormat = optStr(args, 'exportFormat')
    return transcribeFileWithProgress(filePath, exportDir, exportFormat, (doneSec, totalSec) => {
      emitSidecar({
        status: 'transcribe_progress',
        path: filePath,
        progress: Math.round((doneSec / Math.max(totalSec, 1)) * 100),
        done_sec: doneSec,
        total_sec: totalSec
      })
    })
  },

  rust_start_llama_server: async (args) => {
    const model = optStr(args, 'model') ?? 'Qwen3-ASR-0.6B'
    const device = optStr(args, 'device') ?? 'cuda'
    emitStatus('model_loading', { model, kind: 'asr' })
    void (async () => {
      const started = Date.now()
      try {
        await registry().loadAsrByName(model, device, (stage) => {
          emitSidecar({ status: 'model_progress', kind: 'asr', model, stage })
        })
        emitStatus('model_ready', {
          kind: 'asr',
          model,
          device,
          detail: { ok: true, loaded: true },
          load_ms: Date.now() - started
        })
      } catch (e) {
        emitStatus('model_error', { model, msg: e instanceof Error ? e.message : String(e), kind: 'asr' })
      }
    })()
    return { ok: true, loading: true, model }
  },

  rust_stop_llama_server: async () => {
    await llamaEngine.unload()
    return { ok: true, loaded: false }
  },

  rust_llama_server_status: () => ({
    loaded: llamaEngine.isLoaded(),
    model: llamaEngine.modelName() ?? ''
  }),

  rust_unload_sherpa_asr: async () => {
    // 走注册表卸载：SherpaFfiAdapter 就是注册表里的那个单例，
    // 效果一样，但注册表会顺手清掉 activeFramework 缓存 —— 之前这里直接调
    // 绕过注册表直接 unload 会让缓存停在 'onnx'，
    // 上层以为引擎还在跑 → 跳过重载 → 报「sherpa ASR 未加载」。
    await registry().unload('onnx')
    return { status: 'unloaded' }
  },

  // ── 音频 ────────────────────────────────────────────────────────────────
  decode_audio_file: async (args) => {
    const { samples, sampleRate } = await decodeAny(str(args, 'path'))
    return { samples, sample_rate: sampleRate, duration: samples.length / sampleRate }
  },

  rust_list_audio_devices: () => listAudioDevices(),

  rust_read_audio: async (args) => {
    // 返回裸字节（前端拿到 ArrayBuffer）——扩展名白名单 + 32MiB 上限。
    // 用异步读：试听几十 MB 的音频时，同步 readFileSync 会让主线程（进而整个 UI）顿一下。
    const path = str(args, 'path')
    const allowed = ['wav', 'mp3', 'flac', 'ogg', 'm4a']
    const ext = extname(path).replace(/^\./, '').toLowerCase()
    if (!allowed.includes(ext)) {
      throw new Error(`不支持的文件类型: ${ext}`)
    }
    const data = await readFile(path)
    if (data.length > 32 * 1024 * 1024) {
      throw new Error('文件过大（上限 32MB）')
    }
    return new Uint8Array(data)
  },

  rust_open_in_explorer: async (args) => {
    await openInExplorer(str(args, 'path'))
    return null
  },

  // ── 运行时（推理框架 libs）───────────────────────────────────────────────
  check_runtime: () => runtimeStatus(),
  rust_verify_runtime: (args) => verifyRuntimeFull(str(args, 'framework')),
  download_runtime: (args) => {
    const framework = str(args, 'framework')
    // 后台执行 + 事件驱动状态（下载可能耗时数分钟）
    void downloadRuntime(framework).catch((e: unknown) => {
      // 事件已在 downloadRuntime 内部发出；这里只吞掉避免 unhandled rejection
      log.warn(`[framework] 下载 ${framework} 失败: ${e instanceof Error ? e.message : String(e)}`)
    })
    return { ok: true, framework }
  },
  cancel_runtime_download: (args) => {
    const framework = str(args, 'framework')
    const ok = requestCancelRuntime(framework)
    if (!ok) {
      emitStatus('runtime_download_error', { framework, msg: `no active download: ${framework}` })
      return { ok: false }
    }
    return { ok: true }
  },

  // ── TTS ──────────────────────────────────────────────────────────────────
  rust_load_tts_model: (args) => tts.loadTtsModel(str(args, 'modelPath'), str(args, 'device')),
  rust_unload_tts_model: () => tts.unloadTtsModel(),
  rust_set_tts_clone_voice: (args) =>
    tts.setTtsCloneVoice(str(args, 'audioPath'), str(args, 'referenceText')),
  rust_clear_tts_clone_voice: () => tts.clearTtsCloneVoice(),
  rust_tts_voices_list: () => tts.listVoices(),
  rust_tts_voice_add: (args) =>
    tts.addVoice(
      str(args, 'sourcePath'),
      str(args, 'name'),
      str(args, 'note'),
      str(args, 'referenceText')
    ),
  rust_tts_voice_update: (args) =>
    tts.updateVoice(
      str(args, 'id'),
      str(args, 'name'),
      str(args, 'note'),
      str(args, 'referenceText')
    ),
  rust_tts_voice_remove: (args) => tts.removeVoice(str(args, 'id')),
  rust_tts_voice_use: (args) => tts.useVoice(str(args, 'id')),
  rust_record_tts_reference: (args) => {
    const seconds = typeof args.seconds === 'number' ? args.seconds : 6
    return tts.recordTtsReference(seconds)
  },
  rust_list_tts_speakers: () => tts.listTtsSpeakers(),
  rust_set_tts_language: (args) => tts.setTtsLanguage(str(args, 'language')),
  rust_synthesize: (args) =>
    tts.synthesize(str(args, 'text'), str(args, 'voice'), str(args, 'exportDir'), (done, total) => {
      // 单段（短文本）不发进度：与「短文本免分段」一致，界面上不该冒出「第 1/1 段」
      if (total > 1) {
        emitSidecar(tts.ttsProgressPayload(done, total))
      }
    }),
  rust_cancel_tts: () => tts.cancelTts(),

  // ── 调试 ──────────────────────────────────────────────────────────────────
  /** 调试用：硬编码加载 Kokoro-v1_0（CPU），验证 TTS 链路是否通 */
  rust_test_tts_model: async () => {
    const { framework, model } = await ttsRegistry().load('Kokoro-v1_0', 'cpu')
    return { status: 'loaded', model, framework, device: 'cpu' }
  }
}
