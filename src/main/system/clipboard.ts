/**
 * 上屏链路：写剪贴板 + 模拟 Ctrl+V —— 对齐 Rust 版 `src-tauri/src/clipboard.rs`。
 *
 * 必须双库配合：模拟按键不操作剪贴板，写剪贴板不模拟按键。
 * 对齐 CapsWriter 行为：粘贴前保存原剪贴板，粘贴后恢复，避免覆盖用户剪贴板内容。
 *
 * 关键点（Rust 版踩坑记录）：
 * 必须用**虚拟键码**（VK）而不是扫描码。Rust 版用 enigo 的 `Key::V`（VK_V=0x56），
 * 若填进扫描码位置（真实 V 键扫描码是 0x2F）会让 Ctrl+V 在 VS Code / 浏览器 / IM 里收不到。
 * 这里用 uIOhook 的 keyTap（内部走 SendInput + 平台键码映射），语义等价。
 */

import { clipboard } from 'electron'
import { loadUiohook, UIKEY } from './uiohook'
import { sendCtrlV } from '../core/win32/send-input'

/** 睡眠（毫秒） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 模拟 Ctrl+V（uIOhook 优先；失败时回退 Win32 SendInput）。
 *
 * 回退方案走 koffi 直调 user32.dll（旧实现是 PowerShell 现场编译 C# 注入，
 * 既依赖 Windows 命令行工具，又要付一次 PowerShell 冷启动）。
 */
function tapCtrlV(): void {
  const hook = loadUiohook()
  if (hook) {
    hook.keyTap(UIKEY.V, [UIKEY.Ctrl])
    return
  }
  if (!sendCtrlV()) {
    console.warn('[clipboard] SendInput 回退失败（平台不支持或 user32 不可用）')
  }
}

/**
 * 上屏：把文本粘贴到鼠标光标处。
 * 步骤：保存原剪贴板 → 写文本 → Ctrl+V → 延时 → 恢复原剪贴板。
 */
export async function pasteText(text: string): Promise<void> {
  // 1. 保存原剪贴板
  const original = await clipboard.readText()

  // 2. 复制要粘贴的文本
  clipboard.writeText(text)

  // 3. 模拟 Ctrl+V（给目标应用一点拿到新剪贴板内容的时间）
  await sleep(20)
  tapCtrlV()

  // 4. 恢复原剪贴板（延时 200ms，确保目标应用完成粘贴——
  //    过早恢复可能打断粘贴中的应用 → 「时准时不准」）
  if (original) {
    await sleep(200)
    clipboard.writeText(original)
  }
}
