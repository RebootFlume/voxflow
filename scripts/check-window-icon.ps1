# 读取 Electron 窗口的「窗口图标」（任务栏/Alt+Tab 用的就是它），并导出成 PNG 便于肉眼确认。
# 用法：pwsh -NoProfile -File scripts/check-window-icon.ps1 -Out .tmp-winicon.png
param(
  [string]$Out = '.tmp-winicon.png',
  [string]$TitleLike = 'VoxFlow'
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinIconProbe {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetClassLongPtr(IntPtr hWnd, int index);
}
"@

$found = @()
$cb = [WinIconProbe+EnumProc]{
  param($hWnd, $lParam)
  $sb = New-Object System.Text.StringBuilder 512
  [void][WinIconProbe]::GetWindowText($hWnd, $sb, 512)
  $title = $sb.ToString()
  if ($title -and $title -eq $TitleLike) {
    $procId = 0
    [void][WinIconProbe]::GetWindowThreadProcessId($hWnd, [ref]$procId)
    $script:found += [pscustomobject]@{ Hwnd = $hWnd; Title = $title; Pid = $procId; Visible = [WinIconProbe]::IsWindowVisible($hWnd) }
  }
  return $true
}
[void][WinIconProbe]::EnumWindows($cb, [IntPtr]::Zero)

if ($found.Count -eq 0) {
  Write-Output 'NO_WINDOW_FOUND'
  exit 0
}

foreach ($w in $found) {
  $iconBig = [WinIconProbe]::SendMessage($w.Hwnd, 0x007F, [IntPtr]1, [IntPtr]::Zero)   # WM_GETICON, ICON_BIG
  $iconSmall = [WinIconProbe]::SendMessage($w.Hwnd, 0x007F, [IntPtr]0, [IntPtr]::Zero) # WM_GETICON, ICON_SMALL
  $classIcon = [WinIconProbe]::GetClassLongPtr($w.Hwnd, -14)                           # GCLP_HICON
  Write-Output ("WINDOW title='{0}' pid={1} visible={2} hIconBig={3} hIconSmall={4} hClassIcon={5}" -f $w.Title, $w.Pid, $w.Visible, $iconBig, $iconSmall, $classIcon)

  $hIcon = if ($iconBig -ne [IntPtr]::Zero) { $iconBig } elseif ($classIcon -ne [IntPtr]::Zero) { $classIcon } else { $iconSmall }
  if ($hIcon -ne [IntPtr]::Zero) {
    try {
      $ico = [System.Drawing.Icon]::FromHandle($hIcon)
      $bmp = $ico.ToBitmap()
      $file = Join-Path (Get-Location) ($Out -replace '\.png$', "-$($w.Pid).png")
      $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Output ("SAVED {0} size={1}x{2}" -f $file, $bmp.Width, $bmp.Height)
    } catch {
      Write-Output ("ICON_EXTRACT_FAILED " + $_.Exception.Message)
    }
  } else {
    Write-Output 'NO_ICON_ON_WINDOW(系统会回退到 exe 图标)'
  }
}
