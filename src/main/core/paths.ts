/**
 * 运行时资源路径解析。
 *
 * - 生产态：`process.resourcesPath`（electron-builder extraResources 落点）
 * - 开发态：项目根下的 `resources/`（向上找带 package.json 的目录，
 *   兼容 `electron-vite dev` 与 `electron out/main/index.js` 两种启动方式）
 *
 * 资源内容（打包进安装包的只有 `icon.png`）：
 * - `icon.png`：托盘图标（extraResources → 安装目录 resources/icon.png）
 * - `espeak-ng/` 已删除：TTS 的 G2P 词典是各模型自带 `espeak-ng-data`
 *   （sherpa CLI 用 `--kokoro-data-dir` / `--zipvoice-data-dir` 指向模型目录），
 *   与仓库级 espeak-ng 无关。
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

/** 托盘图标路径 */
export function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(projectRoot(), 'resources', 'icon.png')
}

/**
 * 应用图标（窗口 / 任务栏 / Alt+Tab 用）。
 *
 * 开发态必须显式指定：`electron.exe` 自带的是 Electron 官方图标，不给 `icon`
 * 任务栏与 Alt+Tab 就会显示 Electron 的默认图标（用户实际看到的问题）。
 * Windows 用多尺寸 `.ico`（16/32/48/256 都在里面），其他平台用 `.png`。
 * 打包态由 electron-builder 的 `win.icon: build/icon.ico` 写进 exe，这里给
 * extraResources 里的同款 png 兜底（非 Windows 的窗口图标用得到）。
 */
export function appIconPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'icon.png')
  return process.platform === 'win32'
    ? join(projectRoot(), 'build', 'icon.ico')
    : join(projectRoot(), 'build', 'icon.png')
}
