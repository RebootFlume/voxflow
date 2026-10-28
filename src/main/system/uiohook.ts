/**
 * uIOhook 原生模块封装（低层全局键盘监听 + 模拟按键）。
 *
 * 为什么要原生模块：
 * - Electron 的 `globalShortcut` 只在「按下」时触发，**不给松开事件**，
 *   无法实现 CapsWriter 式「按住说话、松手转写」。
 * - 模拟 Ctrl+V 需要 SendInput 级别的虚拟键码注入。
 *
 * uIOhook 使用 Windows WH_KEYBOARD_LL 等价钩子，且提供 N-API 预编译二进制
 * （随 electron-builder 的 install-app-deps 完成 ABI 对齐）。
 *
 * 载入失败不抛错：调用方按「热键不可用」降级处理，应用其余功能不受影响。
 */

export interface UiohookKeyboardEvent {
  type: number
  time: number
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  keycode: number
}

export interface UiohookModule {
  uIOhook: {
    start(): void
    stop(): void
    keyTap(key: number, modifiers?: number[]): void
    keyToggle(key: number, toggle: 'down' | 'up'): void
    on(event: 'keydown', listener: (e: UiohookKeyboardEvent) => void): unknown
    on(event: 'keyup', listener: (e: UiohookKeyboardEvent) => void): unknown
  }
}

let uiohook: UiohookModule['uIOhook'] | null = null
let loadError: string | null = null

/** 载入 uIOhook 原生模块；失败返回 null（原因见 {@link uiohookError}） */
export function loadUiohook(): UiohookModule['uIOhook'] | null {
  if (uiohook || loadError) return uiohook
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('uiohook-napi') as UiohookModule
    uiohook = mod.uIOhook
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e)
    console.warn('[uiohook] 原生模块加载失败，热键与模拟按键不可用:', loadError)
  }
  return uiohook
}

/** uIOhook 载入失败原因（未失败为 null） */
export function uiohookError(): string | null {
  return loadError
}

/** uIOhook 键码（X11 风格，库内部按平台映射） */
export const UIKEY = {
  Ctrl: 29,
  CtrlRight: 3613,
  Alt: 56,
  AltRight: 3640,
  Shift: 42,
  ShiftRight: 54,
  Meta: 3675,
  MetaRight: 3676,
  CapsLock: 58,
  Space: 57,
  Enter: 28,
  Escape: 1,
  Backspace: 14,
  Tab: 15,
  V: 47
} as const
