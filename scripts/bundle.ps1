# VoxFlow 打包脚本
# 用法：
#   npm run bundle        → 打包安装版（NSIS）+ 便携版（zip）
#   npm run bundle:portable → 只打便携版 zip
# 产物在 dist-bundle/ 目录

$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$ver = (Get-Content "$root\src-tauri\tauri.conf.json" | ConvertFrom-Json).version
$out = "$root\dist-bundle"
$tmp = "$out\portable-tmp"

function New-InstallDir {
    param([string]$Name)
    $d = "$tmp\$Name"
    if (Test-Path $d) { Remove-Item $d -Recurse -Force }
    New-Item $d -ItemType Directory -Force | Out-Null
    $d
}

# ---------- 1. 打安装版（NSIS） ----------
Write-Host "`n=== [1/2] NSIS 安装版（Tauri build） ===" -ForegroundColor Cyan
Push-Location "$root"
npm run tauri build 2>&1 | Write-Host
Pop-Location

$nsis = Get-ChildItem "$root\src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($nsis) {
    if (-not (Test-Path $out)) { New-Item $out -ItemType Directory -Force | Out-Null }
    $dest = "$out\VoxFlow-Setup-$ver.exe"
    Copy-Item $nsis.FullName $dest -Force
    Write-Host "安装版: $dest ($([math]::Round((Get-Item $dest).Length/1MB)) MB)" -ForegroundColor Green
} else {
    Write-Warning "NSIS 产物未找到（tauri build 可能失败）"
}

# ---------- 2. 打便携版（zip，exe + libs 同级） ----------
Write-Host "`n=== [2/2] 便携版 zip ===" -ForegroundColor Cyan
$appExe = "$root\src-tauri\target\release\voxflow.exe"
if (-not (Test-Path $appExe)) {
    Write-Error "release exe 不存在: $appExe（先跑 npm run tauri build）"
}

$bundleRoot = New-InstallDir "VoxFlow"
Copy-Item $appExe "$bundleRoot\VoxFlow.exe" -Force

# 便携标记：portable.txt 存在 → 数据根 = exe 旁 data\（便携模式）
Set-Content -Path "$bundleRoot\portable.txt" -Value "VoxFlow portable mode" -Encoding UTF8

# 便携模式：不打包 data/libs（单 exe 最小化），首次运行自动创建 data\（便携数据根）
# libs 走「推理框架」页下载（用户按需），与数据根解耦

$zip = "$out\VoxFlow-Portable-$ver.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$bundleRoot\*" -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $tmp -Recurse -Force

Write-Host "`n便携版: $zip ($([math]::Round((Get-Item $zip).Length/1MB)) MB)" -ForegroundColor Green
Write-Host "`n完成！产物在 dist-bundle/" -ForegroundColor Green
