# VoxFlow 开发环境 libs 准备脚本
# 用法：
#   npm run libs:dev    → 把项目根 libs\ 复制到 target\debug\libs\（与 exe 同级）
#
# 背景：libs（推理引擎）读取逻辑统一为「exe 同级」。
# 开发时 exe 在 src-tauri\target\debug\，libs 在项目根 →
# 开发前先跑本脚本复制过去，让开发环境与打包版行为一致。
#
# ⚠ 目录布局必须与「应用下载的官方包」一致，否则会被判为缺少框架：
#   libs\llama-cpp\llama-server.exe                     ← 扁平（官方 llama.cpp 包就是这样）
#   libs\sherpa-onnx\bin\sherpa-onnx-offline-tts.exe    ← 官方 sherpa 包根为 bin/include/lib，
#   libs\sherpa-onnx\bin\sherpa-onnx-offline-websocket-server.exe   所有 exe 与 dll 都在 bin\ 下
#   不要把 sherpa 的 bin\ 内容摊平到 sherpa-onnx\ 根 —— ASR/TTS 都会找不到 exe。

$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$src = "$root\libs"
$dest = "$root\src-tauri\target\debug\libs"

if (-not (Test-Path $src)) {
    Write-Error "项目根 libs 不存在: $src（先准备推理引擎）"
}
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Copy-Item $src $dest -Recurse -Force

Write-Host "✅ libs 已复制到: $dest" -ForegroundColor Green
Write-Host "   开发时（cargo run / tauri dev）将从 exe 同级 libs 读取推理引擎" -ForegroundColor Cyan
