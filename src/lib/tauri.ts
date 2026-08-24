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

/** Rust 引擎：加载 ASR 模型 */
export function rustLoadAsrModel(modelPath: string, device: string): Promise<Record<string, unknown>> {
  return invoke("rust_load_asr_model", { modelPath, device });
}

/** Rust 引擎：ASR 语音识别（文件） */
export function rustTranscribe(filePath: string): Promise<{ text: string; duration: number }> {
  return invoke("rust_transcribe", { filePath });
}

/** Rust 引擎：查询 ASR 状态 */
export function rustAsrStatus(): Promise<Record<string, unknown>> {
  return invoke("rust_asr_status");
}

/** Rust 引擎：加载 TTS 模型 */
export function rustLoadTtsModel(modelPath: string, device: string): Promise<Record<string, unknown>> {
  return invoke("rust_load_tts_model", { modelPath, device });
}

/** TTS 可用语言/音色（由 Rust 扫 voices 目录得来，不写死） */
export function rustListTtsVoices(): Promise<{ languages: string[]; voices_by_lang: Record<string, string[]>; default_lang: string }> {
  return invoke("rust_list_tts_voices");
}

export function rustSetTtsLanguage(language: string): Promise<{ language: string }> {
  return invoke("rust_set_tts_language", { language });
}

/** Rust 引擎：TTS 合成并保存为文件 */
export function rustSynthesize(
  text: string, voice: string, rate: number, exportDir: string,
): Promise<Record<string, unknown>> {
  return invoke("rust_synthesize", { text, voice, rate, exportDir });
}

/** Rust 引擎：查询 TTS 状态 */
export function rustTtsStatus(): Promise<Record<string, unknown>> {
  return invoke("rust_tts_status");
}

/** Rust 原生音频设备枚举 */
export function rustListAudioDevices(): Promise<Record<string, unknown>> {
  return invoke("rust_list_audio_devices");
}

/** 测试 TTS 模型加载（打印输入输出 tensor 名称） */
export function rustTestTtsModel(): Promise<Record<string, unknown>> {
  return invoke("rust_test_tts_model");
}

/** Rust 原生音频解码 */
export function decodeAudioFile(path: string): Promise<{ samples: number[]; sampleRate: number; duration: number }> {
  return invoke("decode_audio_file", { path });
}
