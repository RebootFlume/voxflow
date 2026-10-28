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
import { spawn } from 'child_process'
import { loadUiohook, UIKEY } from './uiohook'

/** 睡眠（毫秒） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 模拟 Ctrl+V（uIOhook 优先；失败时回退 PowerShell SendInput） */
function tapCtrlV(): void {
  const hook = loadUiohook()
  if (hook) {
    hook.keyTap(UIKEY.V, [UIKEY.Ctrl])
    return
  }
  fallbackSendInputCtrlV()
}

/**
 * 回退方案：PowerShell 调 user32.dll SendInput 发送 Ctrl+V。
 * 仅在 uIOhook 不可用时使用（例如原生模块 ABI 不匹配）。
 */
function fallbackSendInputCtrlV(): void {
  const script = `
$code = @'
using System;
using System.Runtime.InteropServices;
public class Win {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit, Size=40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
}
'@
Add-Type -TypeDefinition $code
$ctrlDown = New-Object Win+KEYBDINPUT
$ctrlDown.wVk = 0x11
$vDown = New-Object Win+KEYBDINPUT
$vDown.wVk = 0x56
$vUp = New-Object Win+KEYBDINPUT
$vUp.wVk = 0x56
$vUp.dwFlags = 2
$ctrlUp = New-Object Win+KEYBDINPUT
$ctrlUp.wVk = 0x11
$ctrlUp.dwFlags = 2
$inputs = New-Object Win+INPUT[] 4
$inputs[0].type = 1; $inputs[0].ki = $ctrlDown
$inputs[1].type = 1; $inputs[1].ki = $vDown
$inputs[2].type = 1; $inputs[2].ki = $vUp
$inputs[3].type = 1; $inputs[3].ki = $ctrlUp
[void][Win]::SendInput(4, $inputs, [Win+INPUT].GetType().SizeOf)
`
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore'
  })
  child.on('error', (e) => console.warn('[clipboard] SendInput 回退失败:', e.message))
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
