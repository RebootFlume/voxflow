/**
 * 主进程运行时状态（退出标记等）。
 *
 * 单独成模块，避免在 Electron 的 `App` 类上做类型扩展（Electron 的类型是
 * `class App` 嵌在 `Electron` 命名空间里，模块增强写起来很别扭）。
 */

/** 应用是否正在退出（区分「关闭到托盘」与「真正退出」） */
let quitting = false

/** 是否正在退出 */
export function isQuitting(): boolean {
  return quitting
}

/** 标记应用正在退出 */
export function setQuitting(value: boolean): void {
  quitting = value
}
