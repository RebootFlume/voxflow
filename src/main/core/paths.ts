/**
 * 运行时资源路径解析。
 *
 * - 生产态：`process.resourcesPath`（electron-builder extraResources 落点）
 * - 开发态：项目根下的 `resources/`（向上找带 package.json 的目录，
 *   兼容 `electron-vite dev` 与 `electron out/main/index.js` 两种启动方式）
 *
 * 资源内容：
 * - `espeak-ng/`：TTS G2P 用的 espeak-ng.exe + DLL + 词典
 * - `pytorch/`：PyTorch 推理 worker.py + runtime-manifest.json
 */

import { app } from 'electron'
import { existsSync } from 'fs'
import { dirname, join } from 'path'

/**
 * 开发态的项目根目录。
 * 从 `app.getAppPath()` 向上找含 `package.json` 的目录；
 * 找不到则退回 `process.cwd()`。
 */
export function projectRoot(): string {
  if (app.isPackaged) return dirname(app.getPath('exe'))
  let dir = app.getAppPath()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

/** 资源根目录 */
export function resourcesRoot(): string {
  return app.isPackaged ? process.resourcesPath : join(projectRoot(), 'resources')
}

/** espeak-ng 资源目录 */
export function espeakDir(): string {
  return join(resourcesRoot(), 'espeak-ng')
}

/** espeak-ng 可执行文件（Windows） */
export function espeakExe(): string {
  return join(espeakDir(), 'espeak-ng.exe')
}

/** PyTorch worker 目录 */
export function pytorchDir(): string {
  return join(resourcesRoot(), 'pytorch')
}

/** PyTorch worker 脚本 */
export function pytorchWorker(): string {
  return join(pytorchDir(), 'worker.py')
}

/** 托盘图标路径 */
export function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(projectRoot(), 'resources', 'icon.png')
}

/** 资源是否存在（用于启动期自检） */
export function hasEspeak(): boolean {
  return existsSync(espeakExe())
}
