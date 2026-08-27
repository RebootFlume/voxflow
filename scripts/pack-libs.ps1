# VoxFlow libs 压缩发布脚本
# 用法：
#   npm run libs:pack    → 压缩 libs 为两个 tar.bz2（分框架）
# 产物在 dist-bundle/libs/：
#   voxflow-libs-llama.tar.bz2    (~550M)
#   voxflow-libs-sherpa.tar.bz2   (~1G)
#
# 压缩后手动上传到 GitHub release（tag: libs-v0.1.0），
# 上传地址：https://github.com/RebootFlume/voxflow/releases/new

$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$sevenZip = "D:\app\7-Zip\7z.exe"
$out = "$root\dist-bundle\libs"

if (-not (Test-Path $sevenZip)) {
    Write-Error "7-Zip 未找到: $sevenZip（请安装或修改脚本路径）"
}
if (-not (Test-Path "$root\libs")) {
    Write-Error "libs 目录不存在: $root\libs"
}

New-Item $out -ItemType Directory -Force | Out-Null

# ---------- 1. 压缩 llama-cpp ----------
Write-Host "=== [1/2] 压缩 llama-cpp ===" -ForegroundColor Cyan
$llamaTar = "$out\llama-cpp.tar"
$llamaBz2 = "$out\voxflow-libs-llama.tar.bz2"
& $sevenZip a -ttar $llamaTar "$root\libs\llama-cpp" | Out-Null
& $sevenZip a -tbzip2 -mx=9 $llamaBz2 $llamaTar | Out-Null
Remove-Item $llamaTar -Force
$size1 = [math]::Round((Get-Item $llamaBz2).Length/1MB)
Write-Host "  llama-cpp → $llamaBz2 ($size1 MB)" -ForegroundColor Green

# ---------- 2. 压缩 sherpa-onnx ----------
Write-Host "=== [2/2] 压缩 sherpa-onnx ===" -ForegroundColor Cyan
$sherpaTar = "$out\sherpa-onnx.tar"
$sherpaBz2 = "$out\voxflow-libs-sherpa.tar.bz2"
& $sevenZip a -ttar $sherpaTar "$root\libs\sherpa-onnx" | Out-Null
& $sevenZip a -tbzip2 -mx=9 $sherpaBz2 $sherpaTar | Out-Null
Remove-Item $sherpaTar -Force
$size2 = [math]::Round((Get-Item $sherpaBz2).Length/1MB)
Write-Host "  sherpa-onnx → $sherpaBz2 ($size2 MB)" -ForegroundColor Green

Write-Host "`n完成！产物在 dist-bundle/libs/" -ForegroundColor Green
Write-Host "上传到 GitHub release（tag: libs-v0.1.0）后，更新 runtime_download.rs 中的 URL" -ForegroundColor Yellow
