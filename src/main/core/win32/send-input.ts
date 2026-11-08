/**
 * 全局键盘输入注入（user32.SendInput）——koffi FFI。
 *
 * 用途：上屏链路里"模拟 Ctrl+V"的回退方案（uIOhook 不可用时）。
 *
 * 为什么不用 PowerShell：旧实现是 `powershell -Command "<C# 源码>"` 现场编译并
 * 注入 SendInput —— 依赖 Windows 命令行工具，且每次都要付一次 PowerShell 冷启动。
 * 直接 FFI 调 user32 更快，也没有外部依赖。
 *
 * 平台限定：仅 Windows；其它平台返回 false（调用方走"无法模拟按键"的降级路径）。
 */

import koffi from 'koffi'

/** INPUT_KEYBOARD：本次注入的是键盘事件 */
const INPUT_KEYBOARD = 1
/** KEYEVENTF_KEYUP：抬起事件 */
const KEYEVENTF_KEYUP = 0x0002
/** VK_CONTROL / VK_V：虚拟键码（Windows 虚拟键码，不是扫描码） */
const VK_CONTROL = 0x11
const VK_V = 0x56

/** INPUT（x64）= type(4) + 4B 对齐填充 + KEYBDINPUT(24) */
const INPUT_SIZE = 32
/** KEYBDINPUT 在 INPUT 内的起始偏移 */
const KEYBDINPUT_OFFSET = 8

interface User32Api {
  sendInput: (count: number, inputs: Buffer, size: number) => number
}

let api: User32Api | null | undefined

function user32Api(): User32Api | null {
  if (api !== undefined) return api
  api = null
  if (process.platform !== 'win32') return api
  try {
    const load = (name: string): ReturnType<typeof koffi.load> => {
      try {
        return koffi.load(name)
      } catch {
        return koffi.load(`C:/Windows/System32/${name}`)
      }
    }
    const user32 = load('user32.dll')
    api = {
      sendInput: user32.func('SendInput', 'uint32', ['uint32', 'void *', 'uint32']) as unknown as User32Api['sendInput']
    }
  } catch {
    api = null
  }
  return api
}

/** 写一个键盘事件到缓冲（KEYBDINPUT：wVk/wScan/dwFlags/time/dwExtraInfo） */
function writeKeyEvent(buf: Buffer, offset: number, vk: number, flags: number): void {
  buf.writeUInt32LE(INPUT_KEYBOARD, offset)
  buf.writeUInt32LE(0, offset + 4) // 对齐填充
  buf.writeUInt16LE(vk, offset + KEYBDINPUT_OFFSET)
  buf.writeUInt16LE(0, offset + KEYBDINPUT_OFFSET + 2) // wScan
  buf.writeUInt32LE(flags, offset + KEYBDINPUT_OFFSET + 4)
  buf.writeUInt32LE(0, offset + KEYBDINPUT_OFFSET + 8) // time
  buf.writeBigUInt64LE(0n, offset + KEYBDINPUT_OFFSET + 12) // dwExtraInfo
}

/**
 * 模拟一次 Ctrl+V（全局，可作用于其它前台应用）。
 *
 * @returns 是否成功注入（false = 平台不支持或 DLL 不可用）
 */
export function sendCtrlV(): boolean {
  const a = user32Api()
  if (!a) return false

  // 两个 INPUT 连续：先 Ctrl 按下 → V 按下 → V 抬起 → Ctrl 抬起
  const buf = Buffer.alloc(INPUT_SIZE * 4)
  writeKeyEvent(buf, INPUT_SIZE * 0, VK_CONTROL, 0)
  writeKeyEvent(buf, INPUT_SIZE * 1, VK_V, 0)
  writeKeyEvent(buf, INPUT_SIZE * 2, VK_V, KEYEVENTF_KEYUP)
  writeKeyEvent(buf, INPUT_SIZE * 3, VK_CONTROL, KEYEVENTF_KEYUP)

  const sent = a.sendInput(4, buf, INPUT_SIZE)
  return sent === 4
}
