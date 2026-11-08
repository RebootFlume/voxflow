/**
 * IPC 桥接层：所有主进程调用集中在此，便于 mock 与替换。
 *
 * 迁移说明（原 `src/lib/tauri.ts`）：
 *  - `invoke(cmd, args)` → `window.voxflow.invoke(cmd, args)`
 *  - `listen(event, cb)` → `window.voxflow.listen(event, cb)`
 *  - `@tauri-apps/plugin-dialog` → `window.voxflow.openDialog(...)`
 *
 * **导出函数名与签名保持不变**，因此其余调用方（stores / hooks / panels）无需改动。
 */

/** 调用主进程命令 */
function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.voxflow.invoke<T>(cmd, args)
}

/** 订阅主进程事件；返回取消订阅函数 */
function listen<T>(event: 'sidecar://event' | 'asr://status', cb: (payload: T) => void): Promise<() => void> {
  return window.voxflow.listen<T>(event, cb)
}

/** Sidecar 安全指令（主进程未就绪时返回模拟响应） */
export function sendToSidecar(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return invoke('send_to_sidecar_safe', { payload })
}

/** 订阅 Sidecar 事件（主进程 emit 的 sidecar 事件） */
export function onSidecarEvent(handler: (payload: Record<string, unknown>) => void): Promise<() => void> {
  return listen<Record<string, unknown>>('sidecar://event', (payload) => handler(payload))
}

/** 查询显存状态（总显存 + 已用 + 各框架占用；框架键由主进程下发，前端不枚举） */
export function rustGetVramStatus(): Promise<{
  available: boolean
  gpu_name: string
  total_mb: number
  used_mb: number
  /** 框架 id → 占用（未加载为 null）。source：wmi=驱动真值 / smi=nvidia-smi / estimate=预估 */
  frameworks?: Record<string, { mb: number; source?: string } | null> | null
}> {
  return invoke('get_vram_status')
}

/** 选择文件夹 */
export async function pickFolder(title: string, defaultPath?: string): Promise<string | null> {
  const result = await window.voxflow.openDialog({
    kind: 'directory',
    title,
    defaultPath
  })
  return result.canceled ? null : (result.paths[0] ?? null)
}

/**
 * 读取音频文件字节（主进程返回裸字节 ⇒ 前端拿到 ArrayBuffer）。
 * 供应用内试听；比走系统默认播放器可靠（不依赖文件关联）。
 */
export async function rustReadAudio(path: string): Promise<ArrayBuffer> {
  const r = await invoke<ArrayBuffer | Uint8Array | number[]>('rust_read_audio', { path })
  if (r instanceof ArrayBuffer) return r
  if (r instanceof Uint8Array) return r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength) as ArrayBuffer
  return new Uint8Array(r).buffer
}

/**
 * 用系统文件管理器打开目录。
 * 失败时抛出可读原因。
 */
export function rustOpenInExplorer(path: string): Promise<void> {
  return invoke<void>('rust_open_in_explorer', { path })
}

// ============================================================
// 原生推理引擎桥接
// ============================================================

/**
 * 统一 ASR 加载入口（路由由注册表决定，前端不做框架推断）。
 * 返回 { reqId }；加载进度/结果由 sidecar 事件（model_loading/progress/ready/error）驱动。
 */
export function rustLoadAsr(model: string, device?: string): Promise<{ ok: boolean; reqId: number; model: string }> {
  return invoke('rust_load_asr', { model, device: device ?? 'cuda' })
}

/** 查询真实引擎状态（自愈对账，会回发 status_snapshot 事件） */
export function rustGetStatus(): Promise<Record<string, unknown>> {
  return invoke('rust_get_status')
}

/** 卸载当前 ASR 引擎（llama/sherpa 统一） */
export function rustUnloadAsr(): Promise<Record<string, unknown>> {
  return invoke('rust_unload_asr')
}

/**
 * 加载前显存预检（只判定，不加载）。
 * `ok=true` = 可以继续加载（`checked=false` 表示无法判定，同样放行 = fail-open）。
 */
export function rustCheckVram(name: string, device: string): Promise<{
  checked: boolean
  ok: boolean
  need_mb: number | null
  free_mb: number | null
  total_mb: number | null
  used_mb: number | null
  reason: string
}> {
  return invoke('rust_check_vram', { name, device })
}

// ============================================================
// ASR 桥接（主力 ASR 入口，支持导出）
// ============================================================

/** 转写音频文件（主力 ASR 入口，支持导出） */
export function rustTranscribeLlama(
  filePath: string,
  exportDir?: string,
  exportFormat?: string
): Promise<{ text: string; duration: number; model: string; saved_path?: string | null }> {
  return invoke('rust_transcribe_llama', { filePath, exportDir, exportFormat })
}

/** 加载 TTS 模型（展示名 / 引擎 id / 目录名均可） */
export function rustLoadTtsModel(modelPath: string, device: string): Promise<Record<string, unknown>> {
  return invoke('rust_load_tts_model', { modelPath, device })
}

/** 卸载当前 TTS 模型（释放引擎，可随后删除模型） */
export function rustUnloadTtsModel(): Promise<Record<string, unknown>> {
  return invoke('rust_unload_tts_model')
}

/** 设置语音克隆参数（参考音频 + 参考文本） */
export function rustSetTtsCloneVoice(audioPath: string, referenceText: string): Promise<Record<string, unknown>> {
  return invoke('rust_set_tts_clone_voice', { audioPath, referenceText })
}

/** 清除语音克隆参数（回到预设音色） */
export function rustClearTtsCloneVoice(): Promise<Record<string, unknown>> {
  return invoke('rust_clear_tts_clone_voice')
}

// ============================================================
// 音色库（录音/上传 → 命名入库 → 库内点击使用）
// ============================================================

/** 音色库条目（落盘在主进程侧音色库目录，前端只读展示） */
export interface TtsVoiceItem {
  id: string
  name: string
  /** 说明（可空） */
  note: string
  /** 参考音频对应文本（克隆模型 requires_text 时必填） */
  reference_text: string
  /** 入库后的音频绝对路径（试听用） */
  audio_path: string
  created_ms: number
}

/** 列出音色库：dir = 落盘目录，active_id = 当前选中音色（无选中为 null） */
export function rustTtsVoicesList(): Promise<{
  dir: string
  active_id: string | null
  voices: TtsVoiceItem[]
}> {
  return invoke('rust_tts_voices_list')
}

/** 把录音/上传的源文件收进音色库并命名（返回新条目 id） */
export function rustTtsVoiceAdd(
  sourcePath: string,
  name: string,
  note: string,
  referenceText: string
): Promise<{ id: string }> {
  return invoke('rust_tts_voice_add', { sourcePath, name, note, referenceText })
}

/** 修改音色条目的名称 / 说明 / 参考文本（音频不变） */
export function rustTtsVoiceUpdate(id: string, name: string, note: string, referenceText: string): Promise<{ ok: true }> {
  return invoke('rust_tts_voice_update', { id, name, note, referenceText })
}

/** 删除音色条目 */
export function rustTtsVoiceRemove(id: string): Promise<{ ok: true }> {
  return invoke('rust_tts_voice_remove', { id })
}

/** 下发该音色到引擎并记为当前选中；失败（模型不支持克隆 / 未加载）即未选中 */
export function rustTtsVoiceUse(id: string): Promise<{ ok: true; name: string }> {
  return invoke('rust_tts_voice_use', { id })
}

/**
 * 录制 TTS 克隆参考音频（16kHz 单声道 wav）。
 * seconds 由主进程钳制到 3–30；peak = 峰值，< 0.01 视为基本静音（UI 提示重录）。
 */
export function rustRecordTtsReference(seconds: number): Promise<{
  path: string
  seconds: number
  sample_rate: number
  peak: number
}> {
  return invoke('rust_record_tts_reference', { seconds })
}

/** 查询当前 TTS 模型的说话人列表 */
export function rustListTtsSpeakers(): Promise<{
  model: string
  num_speakers: number
  speakers: { sid: number; name: string }[]
}> {
  return invoke('rust_list_tts_speakers')
}

/** 设置 TTS 语言 */
export function rustSetTtsLanguage(language: string): Promise<{ language: string }> {
  return invoke('rust_set_tts_language', { language })
}

/** TTS 合成并保存为文件（端到端：文本 → 波形，无语速参数） */
export function rustSynthesize(text: string, voice: string, exportDir: string): Promise<Record<string, unknown>> {
  return invoke('rust_synthesize', { text, voice, exportDir })
}

/** 关闭窗口的行为：true = 隐藏到托盘继续运行（默认），false = 直接退出应用 */
export function rustSetCloseToTray(closeToTray: boolean): Promise<void> {
  return invoke('rust_set_close_to_tray', { closeToTray })
}

/** 取消当前正在进行的 TTS 合成（段边界生效，最多等当前一段跑完） */
export function rustCancelTts(): Promise<{ cancelled: boolean }> {
  return invoke('rust_cancel_tts')
}

/** 音频设备枚举 */
export function rustListAudioDevices(): Promise<Record<string, unknown>> {
  return invoke('rust_list_audio_devices')
}

/** 检测推理框架（libs）安装状态（三态：ready / incomplete / missing） */
export function rustCheckRuntime(): Promise<{
  root: string
  packages: {
    framework: string
    name: string
    version: string
    installed: boolean
    state: 'ready' | 'incomplete' | 'missing'
    missing: string[]
    dir: string
  }[]
}> {
  return invoke('check_runtime')
}

/** 两步验证：①文件检查（缺什么列清单）②试启动（DLL 链能否跑）——不触发下载 */
export function rustVerifyRuntime(framework: string): Promise<{
  state: 'ready' | 'incomplete' | 'missing' | 'error'
  installed: boolean
  missing: string[]
  error?: string
  dir: string
}> {
  return invoke('rust_verify_runtime', { framework })
}

/** 数据根信息（便携/安装判定 + 模型目录）——启动时覆盖旧值 */
export function rustGetDataRootInfo(): Promise<{ portable: boolean; data_root: string; model_root: string }> {
  return invoke('get_data_root_info')
}

/** 下载 + 解压推理框架运行时（llama / sherpa） */
export function rustDownloadRuntime(framework: string): Promise<{ ok: boolean; framework: string }> {
  return invoke('download_runtime', { framework })
}

/** 取消推理框架运行时下载（主进程收尾后会发 runtime_download_cancelled 事件） */
export function rustCancelRuntimeDownload(framework: string): Promise<{ ok: boolean }> {
  return invoke('cancel_runtime_download', { framework })
}

