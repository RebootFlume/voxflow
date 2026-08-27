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
# libs（推理引擎，与 exe 同级——runtime_paths 优先找这里）
Copy-Item "$root\libs" "$bundleRoot\libs" -Recurse -Force

# 便携模式数据目录占位（data\ 存在 → 便携数据根）
New-Item "$bundleRoot\data" -ItemType Directory -Force | Out-Null

$zip = "$out\VoxFlow-Portable-$ver.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$bundleRoot\*" -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $tmp -Recurse -Force

Write-Host "`n便携版: $zip ($([math]::Round((Get-Item $zip).Length/1MB)) MB)" -ForegroundColor Green
Write-Host "`n完成！产物在 dist-bundle/" -ForegroundColor Green
