/** Tauri IPC 桥接层：所有 invoke / listen 调用集中在此，便于 mock 与替换。 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Sidecar 安全指令（Python 不存在时返回模拟响应） */
export function sendToSidecar(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return invoke("send_to_sidecar_safe", { payload });
}

/** 订阅 Sidecar 事件（Rust sidecar.rs emit 的 sidecar://event） */
export function onSidecarEvent(handler: (payload: Record<string, unknown>) => void): Promise<UnlistenFn> {
  return listen<Record<string, unknown>>("sidecar://event", (e) => handler(e.payload));
}

/** 查询显存状态（总显存 + 已用 + 各框架占用；框架键由 Rust 下发，前端不枚举） */
export function rustGetVramStatus(): Promise<{
  available: boolean;
  gpu_name: string;
  total_mb: number;
  used_mb: number;
  /** 框架 id → 占用（未加载为 null）。source：wmi=驱动真值 / smi=nvidia-smi / estimate=预估 */
  frameworks?: Record<string, { mb: number; source?: string } | null> | null;
}> {
  return invoke("get_vram_status");
}

/** 选择文件夹（需 tauri-plugin-dialog） */
export async function pickFolder(title: string, defaultPath?: string): Promise<string | null> {
  const dialog = await import("@tauri-apps/plugin-dialog");
  const result = await dialog.open({ directory: true, multiple: false, title, defaultPath });
  return typeof result === "string" ? result : null;
}

/** 用系统文件管理器打开目录 */
export function openPath(path: string): Promise<void> {
  return import("@tauri-apps/plugin-opener").then((m) => m.openPath(path));
}

// ============================================================
// Rust 原生推理引擎桥接（Phase 3）
// ============================================================

/**
 * 统一 ASR 加载入口（路由由 Rust 注册表决定，前端不做框架推断）。
 * 返回 { reqId }；加载进度/结果由 sidecar://event（model_loading/progress/ready/error）驱动。
 */
export function rustLoadAsr(model: string, device?: string): Promise<{ ok: boolean; reqId: number; model: string }> {
  return invoke("rust_load_asr", { model, device: device ?? "cuda" });
}

/** 查询真实引擎状态（自愈对账，会回发 status_snapshot 事件） */
export function rustGetStatus(): Promise<Record<string, unknown>> {
  return invoke("rust_get_status");
}

/** 卸载当前 ASR 引擎（llama/sherpa 统一） */
export function rustUnloadAsr(): Promise<Record<string, unknown>> {
  return invoke("rust_unload_asr");
}

/**
 * 加载前显存预检（只判定，不加载）。
 * `ok=true` = 可以继续加载（`checked=false` 表示无法判定，同样放行 = fail-open）。
 */
export function rustCheckVram(name: string, device: string): Promise<{
  checked: boolean;
  ok: boolean;
  need_mb: number | null;
  free_mb: number | null;
  total_mb: number | null;
  used_mb: number | null;
  reason: string;
}> {
  return invoke("rust_check_vram", { name, device });
}

// ============================================================
// llama-server 子进程桥接（ASR 主力路线）
// ============================================================

/** 通过 llama-server 转写音频文件（主力 ASR 入口，支持导出） */
export function rustTranscribeLlama(
  filePath: string,
  exportDir?: string,
  exportFormat?: string,
): Promise<{ text: string; duration: number; model: string; saved_path?: string }> {
  return invoke("rust_transcribe_llama", { filePath, exportDir, exportFormat });
}

/** Rust 引擎：加载 TTS 模型（唯一命令；展示名 / 引擎 id / 目录名均可） */
export function rustLoadTtsModel(modelPath: string, device: string): Promise<Record<string, unknown>> {
  return invoke("rust_load_tts_model", { modelPath, device });
}

/** 卸载当前 TTS 模型（释放引擎，可随后删除模型） */
export function rustUnloadTtsModel(): Promise<Record<string, unknown>> {
  return invoke("rust_unload_tts_model");
}

/** 设置语音克隆参数（参考音频 + 参考文本） */
export function rustSetTtsCloneVoice(
  audioPath: string,
  referenceText: string,
): Promise<Record<string, unknown>> {
  return invoke("rust_set_tts_clone_voice", { audioPath, referenceText });
}

/** 清除语音克隆参数（回到预设音色） */
export function rustClearTtsCloneVoice(): Promise<Record<string, unknown>> {
  return invoke("rust_clear_tts_clone_voice");
}

/**
 * 录制 TTS 克隆参考音频（16kHz 单声道 wav）。
 * seconds 由 Rust 钳制到 3–30；peak = 峰值，< 0.01 视为基本静音（UI 提示重录）。
 */
export function rustRecordTtsReference(seconds: number): Promise<{
  path: string;
  seconds: number;
  sample_rate: number;
  peak: number;
}> {
  return invoke("rust_record_tts_reference", { seconds });
}

/** 查询当前 TTS 模型的说话人列表 */
export function rustListTtsSpeakers(): Promise<{
  model: string;
  num_speakers: number;
  speakers: { sid: number; name: string }[];
}> {
  return invoke("rust_list_tts_speakers");
}


export function rustSetTtsLanguage(language: string): Promise<{ language: string }> {
  return invoke("rust_set_tts_language", { language });
}

/** Rust 引擎：TTS 合成并保存为文件（端到端：文本 → 波形，无语速参数） */
export function rustSynthesize(
  text: string, voice: string, exportDir: string,
): Promise<Record<string, unknown>> {
  return invoke("rust_synthesize", { text, voice, exportDir });
}

/** Rust 原生音频设备枚举 */
export function rustListAudioDevices(): Promise<Record<string, unknown>> {
  return invoke("rust_list_audio_devices");
}

/** 检测推理框架（libs）安装状态（三态：ready / incomplete / missing） */
export function rustCheckRuntime(): Promise<{
  root: string;
  packages: { framework: string; name: string; version: string; installed: boolean; state: "ready" | "incomplete" | "missing"; missing: string[]; dir: string }[];
}> {
  return invoke("check_runtime");
}

/** 两步验证：①文件检查（缺什么列清单）②试启动（DLL 链能否跑）——不触发下载 */
export function rustVerifyRuntime(framework: string): Promise<{
  state: "ready" | "incomplete" | "missing" | "error";
  installed: boolean;
  missing: string[];
  error?: string;
  dir: string;
}> {
  return invoke("rust_verify_runtime", { framework });
}

/** 数据根信息（便携/安装判定 + 模型目录）——启动时覆盖 localStorage 旧值 */
export function rustGetDataRootInfo(): Promise<{ portable: boolean; data_root: string; model_root: string }> {
  return invoke("get_data_root_info");
}

/** 下载 + 解压推理框架运行时（llama / sherpa） */
export function rustDownloadRuntime(framework: string): Promise<{ ok: boolean; framework: string }> {
  return invoke("download_runtime", { framework });
}

/** 取消推理框架运行时下载（Rust 侧收尾后会发 runtime_download_cancelled 事件） */
export function rustCancelRuntimeDownload(framework: string): Promise<{ ok: boolean }> {
  return invoke("cancel_runtime_download", { framework });
}
