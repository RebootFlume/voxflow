/**
 * 录音热键：CapsLock / 组合键 —— 对齐 Rust 版 `src-tauri/src/hotkey.rs`。
 *
 * 按下 → 开始录音；松开 → 停止录音 → 转写 → 写剪贴板 + Ctrl+V 上屏 → 发 `recognized` 事件。
 *
 * ## 与 Rust 版的关键差异
 * Rust 版用 `rdev`（低层键盘钩子）拿 CapsLock 的按下/松开，用
 * `tauri-plugin-global-shortcut` 拿组合键的按下/松开。
 * Electron 的 `globalShortcut` **只给触发、不给松开**，无法实现「按住说话」，
 * 因此这里统一用 uIOhook（Windows WH_KEYBOARD_LL 等价物）监听全部按键的
 * keydown / keyup —— CapsLock 与组合键走同一条路径，行为与 Rust 版一致。
 *
 * uIOhook 是原生模块（预编译 N-API 二进制，已随 electron-builder rebuild）。
 * 载入失败时热键不可用，但应用其余功能不受影响。
 */

import { emitAsrStatus, emitSidecar } from '../core/events'
import { log } from '../core/logger'
import { registry } from '../inference/registry'
import { transcribeLong } from '../inference/transcribe'
import { pasteText } from './clipboard'
import { startCapture, stopCapture } from './capture'
import { loadUiohook, UIKEY, type UiohookKeyboardEvent } from './uiohook'

/** uIOhook 键码表（X11 风格，库内部按平台映射；数值以 `uiohook-napi` 的 UiohookKey 为准） */
const KEY_CODES: Record<string, number> = {
  CapsLock: UIKEY.CapsLock,
  Space: UIKEY.Space,
  Enter: UIKEY.Enter,
  Escape: UIKEY.Escape,
  Backspace: UIKEY.Backspace,
  Tab: UIKEY.Tab,
  Insert: 3666,
  Delete: 3667,
  Home: 3655,
  End: 3663,
  PageUp: 3657,
  PageDown: 3665,
  ArrowLeft: 57419,
  ArrowUp: 57416,
  ArrowRight: 57421,
  ArrowDown: 57424,
  Ctrl: UIKEY.Ctrl,
  CtrlRight: UIKEY.CtrlRight,
  Alt: UIKEY.Alt,
  AltRight: UIKEY.AltRight,
  Shift: UIKEY.Shift,
  ShiftRight: UIKEY.ShiftRight,
  Meta: UIKEY.Meta,
  MetaRight: UIKEY.MetaRight,
  // 功能键（浏览器 keydown 的 e.key 就是 "F1".."F12"；码值与 uiohook-napi 的 UiohookKey 一致）
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  F11: 87,
  F12: 88
}

/**
 * 字母 / 数字键码（X11：a=38 起，0=11 起）。
 *
 * **必须严格单字符**：JS 的 `>=` / `<=` 对字符串是字典序比较，多字符字符串
 * （"F9" / "F12" / "Bogus"）会通过 `'A'`..`'Z'` 的区间判断，被换算成一个
 * 不存在的键码（实测 `"F9" => 43`、`"Bogus" => 39`）——结果就是热键"设置成功"
 * 却永远匹配不上真实按键（用户看到的现象：改成 F9 后按住录音没反应）。
 * 功能键走上面的 KEY_CODES 精确表，这里只负责单字符。
 */
function letterCode(ch: string): number | null {
  if (ch.length !== 1) return null
  const c = ch.charCodeAt(0)
  if (c >= 97 && c <= 122) return 38 + (c - 97) // a-z
  if (c >= 65 && c <= 90) return 38 + (c - 65) // A-Z
  if (c >= 48 && c <= 57) return 11 + (c - 48) // 0-9
  return null
}

/** 修饰键集合（用于解析热键字符串时的白名单） */
const MODIFIER_KEYS = new Set(['Ctrl', 'CtrlRight', 'Alt', 'AltRight', 'Shift', 'ShiftRight', 'Meta', 'MetaRight'])

interface HotkeySpec {
  /** 主键码（最后一个键） */
  code: number
  /** 需要的修饰键（'ctrl' | 'alt' | 'shift' | 'meta'） */
  modifiers: Set<string>
  /** 显示用原文 */
  raw: string
}

/** 解析热键字符串（"CapsLock" / "Alt+Space" / "Ctrl+Shift+K"） */
export function parseHotkey(hotkey: string): HotkeySpec {
  const parts = hotkey
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) throw new Error(`无效热键: '${hotkey}'`)

  const main = parts[parts.length - 1]
  const code = KEY_CODES[main] ?? letterCode(main)
  if (code === undefined || code === null) {
    throw new Error(`无效热键: '${hotkey}'（不支持的按键 '${main}'）`)
  }

  const modifiers = new Set<string>()
  for (const p of parts.slice(0, -1)) {
    if (!MODIFIER_KEYS.has(p)) {
      throw new Error(`无效热键: '${hotkey}'（不支持的修饰键 '${p}'）`)
    }
    if (p === 'Ctrl' || p === 'CtrlRight') modifiers.add('ctrl')
    else if (p === 'Alt' || p === 'AltRight') modifiers.add('alt')
    else if (p === 'Shift' || p === 'ShiftRight') modifiers.add('shift')
    else modifiers.add('meta')
  }
  return { code, modifiers, raw: hotkey }
}

/** 当前注册的热键（由 set_hotkey 命令更新） */
let currentSpec: HotkeySpec | null = null
let listening = false
let recording = false

interface KeyEvent extends UiohookKeyboardEvent {}

/** 判断事件是否命中当前热键 */
function matches(spec: HotkeySpec, e: KeyEvent): boolean {
  if (e.keycode !== spec.code) return false
  if (spec.modifiers.has('ctrl') !== e.ctrlKey) return false
  if (spec.modifiers.has('alt') !== e.altKey) return false
  if (spec.modifiers.has('shift') !== e.shiftKey) return false
  if (spec.modifiers.has('meta') !== e.metaKey) return false
  return true
}

/**
 * 启动全局按键监听（幂等）。
 * 必须在 app ready 之后调用。
 */
export function startHotkeyListener(): void {
  if (listening) return
  const hook = loadUiohook()
  if (!hook) {
    log.warn('[hotkey] uIOhook 不可用，录音热键未启用')
    return
  }

  hook.on('keydown', (e: KeyEvent) => {
    const spec = currentSpec
    if (!spec || recording) return
    if (!matches(spec, e)) return
    recording = true
    emitAsrStatus('recording')
    void beginCapture()
  })

  hook.on('keyup', (e: KeyEvent) => {
    const spec = currentSpec
    if (!spec || !recording) return
    if (!matches(spec, e)) return
    recording = false
    emitAsrStatus('recognizing')
    void endCaptureAndTranscribe()
  })

  hook.start()
  listening = true
  log.info('[hotkey] 全局按键监听已启动')
}

/** 停止全局按键监听 */
export function stopHotkeyListener(): void {
  if (!listening) return
  const hook = loadUiohook()
  hook?.stop()
  listening = false
}

/** 设置并注册新的录音热键 */
export function setHotkey(hotkey: string): void {
  currentSpec = parseHotkey(hotkey)
  if (!listening) startHotkeyListener()
  // 成功也记一条：运行日志里能直接看到"现在真正生效的键"，排查"改了没反应"时有用
  log.info(`[hotkey] 录音热键已注册：${hotkey}`)
}

/** 开始录音 */
async function beginCapture(): Promise<void> {
  try {
    await startCapture()
  } catch (e) {
    recording = false
    const msg = `录音启动失败: ${e instanceof Error ? e.message : String(e)}`
    log.error(`[capture] ${msg}`)
    emitSidecar({ status: 'recognition_error', error: msg })
    emitAsrStatus('idle')
  }
}

/** 停止录音 → 转写 → 上屏 */
async function endCaptureAndTranscribe(): Promise<void> {
  let samples: Float32Array
  try {
    const result = await stopCapture()
    samples = result.samples
  } catch (e) {
    const msg = `录音停止失败: ${e instanceof Error ? e.message : String(e)}`
    log.error(`[capture] ${msg}`)
    emitSidecar({ status: 'recognition_error', error: msg })
    emitAsrStatus('idle')
    return
  }

  // 太短视为误触
  if (samples.length < 1600) {
    emitAsrStatus('idle')
    return
  }

  // 转写：经注册表选择当前已加载的 ASR 引擎
  const reg = registry()
  let result: string
  try {
    if (!reg.activeEngine()) {
      // 无已加载引擎：自动拉起「用户最近一次选择」的模型
      await reg.loadRequestedAsr(() => {})
    }
    const engine = reg.activeEngine()
    if (!engine) throw new Error('注册表无可用引擎')
    result = await transcribeLong(engine, samples, 16000, () => {})
  } catch (e) {
    const msg = `转写失败: ${e instanceof Error ? e.message : String(e)}`
    log.warn(`[hotkey] ${msg}`)
    emitSidecar({ status: 'recognition_error', error: msg })
    emitAsrStatus('idle')
    return
  }

  // 判断用的引擎名（前端展示）
  const engineName = reg.activeFrameworkName()

  // 上屏前清理句尾标点（对齐 CapsWriter trash_punc）
  const text = stripTrailingPunct(result)

  // 上屏：写剪贴板 + Ctrl+V 粘贴到鼠标光标处
  try {
    await pasteText(text)
  } catch (e) {
    const msg = `识别成功但上屏失败: ${e instanceof Error ? e.message : String(e)}`
    log.error(`[hotkey] ${msg}`)
    emitSidecar({ status: 'recognition_error', error: msg })
    emitAsrStatus('idle')
    return
  }

  emitSidecar({ status: 'recognized', text, engine: engineName })
  emitAsrStatus('idle')
}

/**
 * 清理识别文本的句尾标点（对齐 CapsWriter `trash_punc = '，。,。'` 语义）：
 * 文本 >1 字且末字符属于 {， 。 , .} 时去掉它；`？！…` 等有语义的标点保留。
 */
export function stripTrailingPunct(text: string): string {
  const trash = ['，', '。', ',', '.']
  let s = text.replace(/\s+$/u, '')
  const chars = [...s]
  if (chars.length > 1) {
    const last = chars[chars.length - 1]
    if (trash.includes(last)) s = chars.slice(0, -1).join('')
  }
  return s
}
