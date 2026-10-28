/**
 * 推理框架运行时（libs/）状态检测 —— 对齐 Rust 版
 * `src-tauri/src/inference/runtime_download.rs` 的 `runtime_status` / `verify_runtime`。
 *
 * 运行时包结构：
 *   <exe旁>/libs/llama-cpp/llama-server.exe
 *   <exe旁>/libs/sherpa-onnx/bin/sherpa-onnx-offline-websocket-server
 *
 * 阶段一先提供**只读检测**（文件检查）；下载/解压在阶段三实现。
 */

import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { llamaRuntimeDir, sherpaRuntimeDir } from '../inference/runtime-paths'

export type RuntimeState = 'ready' | 'incomplete' | 'missing' | 'error'

export interface RuntimePackage {
  framework: string
  name: string
  version: string
  installed: boolean
  state: RuntimeState
  missing: string[]
  dir: string
}

/** 运行时包定义（framework = 引擎注册键；runtime_key = 运行时包键） */
export const RUNTIME_PACKAGES = [
  { framework: 'gguf', name: 'llama.cpp', runtimeKey: 'gguf', dir: 'llama-cpp', required: ['llama-server.exe'] },
  {
    framework: 'onnx',
    name: 'sherpa-onnx',
    runtimeKey: 'onnx',
    dir: 'sherpa-onnx',
    required: ['bin/sherpa-onnx-offline-websocket-server']
  }
] as const

/** 探测单个运行时包状态 */
function probe(pkg: (typeof RUNTIME_PACKAGES)[number]): RuntimePackage {
  const dir = pkg.dir === 'llama-cpp' ? llamaRuntimeDir() : sherpaRuntimeDir()
  const missing: string[] = []
  for (const rel of pkg.required) {
    if (!existsSync(join(dir, rel))) missing.push(rel)
  }
  const installed = missing.length === 0
  return {
    framework: pkg.runtimeKey,
    name: pkg.name,
    version: '',
    installed,
    state: installed ? 'ready' : missing.length === pkg.required.length ? 'missing' : 'incomplete',
    missing,
    dir
  }
}

/**
 * 运行时状态总览（对应 Rust 的 `runtime_status`）。
 * 返回结构与前端消费的字段保持一致。
 */
export function runtimeStatus(): {
  status: string
  root: string
  packages: RuntimePackage[]
} {
  const root = llamaRuntimeDir().replace(/[\\/]llama-cpp$/, '')
  return {
    status: 'runtime_status',
    root,
    packages: RUNTIME_PACKAGES.map(probe)
  }
}

/**
 * 两步验证：① 文件检查（缺什么列清单）② 试启动（DLL 链能否跑）——不触发下载。
 * 阶段一实现第一步（文件检查）；试启动在阶段三补齐。
 */
export async function verifyRuntime(framework: string): Promise<{
  state: RuntimeState
  installed: boolean
  missing: string[]
  error?: string
  dir: string
}> {
  const pkg = RUNTIME_PACKAGES.find((p) => p.runtimeKey === framework || p.framework === framework)
  if (!pkg) {
    return { state: 'error', installed: false, missing: [], error: `未知运行时: ${framework}`, dir: '' }
  }
  const probeResult = probe(pkg)
  return {
    state: probeResult.state,
    installed: probeResult.installed,
    missing: probeResult.missing,
    dir: probeResult.dir
  }
}

/** 目录内是否有可执行文件（辅助判断） */
export function hasExecutable(dir: string, names: string[]): boolean {
  if (!existsSync(dir)) return false
  try {
    const files = readdirSync(dir)
    return names.some((n) => files.includes(n) && statSync(join(dir, n)).isFile())
  } catch {
    return false
  }
}
