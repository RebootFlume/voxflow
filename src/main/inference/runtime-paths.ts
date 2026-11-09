/**
 * 推理引擎运行时目录（libs）。
 *
 * 单一逻辑：libs 永远在 exe 同级目录。
 * - 打包版（安装/便携）：libs/ 与 exe 同级（用户从「推理框架」页下载解压到那）
 * - 开发版：libs/ 也在 exe 同级（开发时把项目根 libs 复制过去）
 *
 * 不再做多路径回退（环境变量 / _up_ / 项目根）——统一只认 exe 目录，
 * 避免跨项目/残留目录误判。
 *
 * **目录名从 RUNTIME_PACKAGES 派生**，这里不再出现 'llama-cpp' 之类的字面量：
 * 之前 targetDir 在这两处各写一份，改运行时包名时必须同时改两处，漏了就必然找不到 dll。
 */

import { join } from 'path'
import { appRootDir, exeDir } from '../core/data-root'
import { RUNTIME_PACKAGES, type RuntimePkg } from './runtime-packages'

export { exeDir, appRootDir }

/**
 * libs 根目录（**应用根目录**旁，不是 exe 旁）。
 *
 * InnoSetup 版把 Electron 放在 bin\ 下，libs 必须落在根目录 ——
 * 与 data\ 同级（见 appRootDir 的说明）。
 */
export function libsDir(): string {
  return join(appRootDir(), 'libs')
}

/** 某运行时包的解压目录（`<libs>/<targetDir>`） */
export function runtimePkgDir(framework: RuntimePkg['framework']): string {
  const pkg = RUNTIME_PACKAGES.find((p) => p.framework === framework)
  if (!pkg) throw new Error(`未登记的运行时包: ${framework}（见 RUNTIME_PACKAGES）`)
  return join(libsDir(), pkg.targetDir)
}

/** llama.cpp 运行时目录（含 llama.dll / mtmd.dll / ggml*.dll） */
export function llamaRuntimeDir(): string {
  return runtimePkgDir('gguf')
}

/** sherpa-onnx 运行时目录（含 bin/ include/ lib/） */
export function sherpaRuntimeDir(): string {
  return runtimePkgDir('onnx')
}

/** audio.cpp 运行时目录（含 libs/audiocpp.dll 与 ggml 各后端 dll） */
export function audiocppRuntimeDir(): string {
  return runtimePkgDir('audiocpp')
}
