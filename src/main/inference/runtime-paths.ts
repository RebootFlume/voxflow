/**
 * 推理引擎运行时目录（libs）—— 对齐 Rust 版 `src-tauri/src/inference/runtime_paths.rs`。
 *
 * 单一逻辑：libs 永远在 exe 同级目录。
 * - 打包版（安装/便携）：libs/ 与 exe 同级（用户从「推理框架」页下载解压到那）
 * - 开发版：libs/ 也在 exe 同级（开发时把项目根 libs 复制过去）
 *
 * 不再做多路径回退（环境变量 / _up_ / 项目根）——统一只认 exe 目录，
 * 避免跨项目/残留目录误判。
 */

import { join } from 'path'
import { exeDir } from '../core/data-root'

export { exeDir }

/** libs 根目录（exe 旁） */
export function libsDir(): string {
  return join(exeDir(), 'libs')
}

/** llama-cpp 运行时目录（含 llama.dll / mtmd.dll / ggml*.dll） */
export function llamaRuntimeDir(): string {
  return join(libsDir(), 'llama-cpp')
}

/** sherpa-onnx 运行时目录（含 websocket server exe） */
export function sherpaRuntimeDir(): string {
  return join(libsDir(), 'sherpa-onnx')
}

/** audio.cpp 运行时目录（含 libs/audiocpp.dll） */
export function audiocppRuntimeDir(): string {
  return join(libsDir(), 'audio-cpp')
}

/**
 * sherpa-onnx 工具可执行文件的**规范位置**：`<sherpa_runtime_dir>/bin/<name>`。
 *
 * 官方包根 = `bin/include/lib`，所有 CLI（offline / offline-tts / offline-websocket-server）
 * 与运行库同处 `bin/` —— 下载一次即可让 ASR 与 TTS 两个工具同时可用。
 * 本函数是布局的单一真源：下载校验 marker、ASR 引擎、TTS 引擎都走这里，
 * 避免"一处假设 bin/、另一处假设扁平"导致必然有一侧失败。
 */
export function sherpaExe(name: string): string {
  return join(sherpaRuntimeDir(), 'bin', name)
}

/** exe 同级目录（libs / data 等资源的基准） */
export function appDir(): string {
  return exeDir()
}
