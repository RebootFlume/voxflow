# VoxFlow 打包脚本（Electron 版）
# 用法：
#   npm run bundle        → 打包安装版（NSIS）+ 便携版（zip）
#   npm run bundle:portable → 只打便携版 zip
# 产物在 release/ 与 dist-bundle/ 目录
#
# 命名规则与 Tauri 版保持一致（AGENT.md 规则 13）：
#   安装版：VoxFlow-Setup-<ver>.exe
#   便携版：VoxFlow-Portable-<ver>.zip
#
# 与 Tauri 版的差异：Electron 无法产出真正的单文件 portable.exe
# （自解压方案每次启动都要解压上百兆 Chromium，启动延迟数秒）。
# 便携版因此保持「zip 解压即用」的形态：解压后直接运行 VoxFlow.exe。

$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$pkg = Get-Content "$root\package.json" -Raw | ConvertFrom-Json
$ver = $pkg.version
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
Write-Host "`n=== [1/2] NSIS 安装版（electron-builder --win） ===" -ForegroundColor Cyan
Push-Location "$root"
npm run build:win   # 内含 typecheck（一致性 + 两侧 tsc），失败即中止
$buildExit = $LASTEXITCODE
Pop-Location
if ($buildExit -ne 0) {
    Write-Error "electron-builder --win 失败（退出码 $buildExit）"
}

$nsis = Get-ChildItem "$root\release\*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($nsis) {
    if (-not (Test-Path $out)) { New-Item $out -ItemType Directory -Force | Out-Null }
    $dest = "$out\VoxFlow-Setup-$ver.exe"
    Copy-Item $nsis.FullName $dest -Force
    Write-Host "安装版: $dest ($([math]::Round((Get-Item $dest).Length/1MB)) MB)" -ForegroundColor Green
} else {
    Write-Warning "NSIS 产物未找到（electron-builder 可能失败）"
}

# ---------- 2. 打便携版（zip，解压即用） ----------
Write-Host "`n=== [2/2] 便携版 zip ===" -ForegroundColor Cyan
$appExe = "$root\release\win-unpacked\VoxFlow.exe"
if (-not (Test-Path $appExe)) {
    $appExe = "$root\release\win-unpacked\voxflow.exe"
}
if (-not (Test-Path $appExe)) {
    Write-Error "release exe 不存在: $appExe（先跑 npm run build:win）"
}

$bundleRoot = New-InstallDir "VoxFlow"
Copy-Item "$root\release\win-unpacked\*" $bundleRoot -Recurse -Force

# 便携标记：portable.txt 存在 → 数据根 = exe 旁 data\（便携模式）
Set-Content -Path "$bundleRoot\portable.txt" -Value "VoxFlow portable mode" -Encoding UTF8

# 便携模式：不打包 data/libs（模型与推理框架按需下载，与数据根解耦）
$zip = "$out\VoxFlow-Portable-$ver.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$bundleRoot\*" -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $tmp -Recurse -Force

Write-Host "`n便携版: $zip ($([math]::Round((Get-Item $zip).Length/1MB)) MB)" -ForegroundColor Green
Write-Host "`n完成！产物在 dist-bundle/" -ForegroundColor Green
