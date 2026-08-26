# ============================================================
# VoxFlow ASR/TTS 引擎验证 —— 环境搭建脚本
#
# 用途：一键下载并解压两条技术路线的全部依赖
#   路线A：llama.cpp 官方预编译（含 mtmd 音频支持）+ Qwen3-ASR GGUF
#   路线B：sherpa-onnx 官方预编译 + SenseVoice(ASR) + VITS(TTS)
#
# 用法：
#   cd benchmarks
#   .\setup.ps1                          # 默认 CUDA 版 + 走代理
#   .\setup.ps1 -Backend cpu             # CPU 版
#   .\setup.ps1 -Proxy ""                # 不走代理直连
# ============================================================
param(
    [ValidateSet("cuda", "cpu")]
    [string]$Backend = "cuda",
    [string]$Proxy = "http://127.0.0.1:10808",   # 你 config.json 里配的代理；传 "" 直连
    [switch]$SkipLlama,
    [switch]$SkipSherpa
)

$ErrorActionPreference = "Stop"
$Root     = $PSScriptRoot
$Downloads = Join-Path $Root "_downloads"
New-Item -ItemType Directory -Force -Path $Downloads | Out-Null

function Get-File($Url, $Out) {
    if (Test-Path $Out) { Write-Host "[skip] 已存在: $(Split-Path $Out -Leaf)" ; return }
    Write-Host "[down] $(Split-Path $Out -Leaf) ..."
    $args = @("-L", "-C", "-", "--retry", "3", "--max-time", "3600",
              "-o", $Out, "-#")
    if ($Proxy) { $args += @("-x", $Proxy) }
    $args += $Url
    & curl.exe @args
    if ($LASTEXITCODE -ne 0) { throw "下载失败: $Url" }
}

function Expand-Pkg($Pkg, $Dest) {
    # 用「标记文件」判断是否已解压（目录可能因预创建而存在，不能作为依据）
    $marker = "$Pkg.extracted"
    if (Test-Path $marker) { Write-Host "[skip] 已解压: $(Split-Path $Pkg -Leaf)"; return }
    Write-Host "[unzip] $(Split-Path $Pkg -Leaf)"
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null

    # 优先用 7-Zip；找不到时回退系统自带 bsdtar
    $7z = Get-Command 7z -ErrorAction SilentlyContinue
    if (-not $7z) {
        foreach ($p in @("$env:ProgramFiles\7-Zip\7z.exe", "${env:ProgramFiles(x86)}\7-Zip\7z.exe")) {
            if (Test-Path $p) { $7z = @{ Source = $p }; break }
        }
    }

    if ($7z) {
        $exe = if ($7z -is [string] -or $7z.Source) { if ($7z.Source) { $7z.Source } else { $7z.Name } } else { "7z" }
        if ($Pkg -like "*.tar.bz2" -or $Pkg -like "*.tar.gz") {
            # 两层解压：先解压缩层得到 .tar，再解开 tar
            $work = "$Pkg.__tmp"
            New-Item -ItemType Directory -Force -Path $work | Out-Null
            & $exe x $Pkg "-o$work" -y | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "7z 解压失败(层1): $Pkg" }
            $inner = Get-ChildItem $work -Recurse -File -Include *.tar | Select-Object -First 1
            if (-not $inner) { throw "未找到内层 tar: $Pkg" }
            & $exe x $inner.FullName "-o$Dest" -y | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "7z 解压失败(层2): $Pkg" }
            Remove-Item -Recurse -Force $work
        } else {
            & $exe x $Pkg "-o$Dest" -y | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "7z 解压失败: $Pkg" }
        }
    } else {
        # 回退：Windows 自带 bsdtar，必须写全路径，避免 PATH 里 GNU tar 把 "D:" 当远程主机
        $Tar = Join-Path $env:SystemRoot "System32\tar.exe"
        & $Tar -xf $Pkg -C $Dest
        if ($LASTEXITCODE -ne 0) {
            if ($Pkg -like "*.zip") { Expand-Archive -Path $Pkg -DestinationPath $Dest -Force }
            else { throw "解压失败: $Pkg" }
        }
    }
    New-Item -ItemType File -Force -Path $marker | Out-Null
}

# ──────────────────────────────────────────────
# 路线 A：llama.cpp + Qwen3-ASR GGUF
# ──────────────────────────────────────────────
if (-not $SkipLlama) {
    $llamaDir = Join-Path $Root "llama-cpp"

    # 1. 预编译二进制（b10622 实测存在这些资产）
    if ($Backend -eq "cuda") {
        Get-File "https://github.com/ggml-org/llama.cpp/releases/download/b10622/llama-b10622-bin-win-cuda-12.4-x64.zip" "$Downloads\llama-bin.zip"
        Get-File "https://github.com/ggml-org/llama.cpp/releases/download/b10622/cudart-llama-bin-win-cuda-12.4-x64.zip" "$Downloads\cudart.zip"
    } else {
        Get-File "https://github.com/ggml-org/llama.cpp/releases/download/b10622/llama-b10622-bin-win-cpu-x64.zip" "$Downloads\llama-bin.zip"
    }
    Expand-Pkg "$Downloads\llama-bin.zip" $llamaDir
    if (Test-Path "$Downloads\cudart.zip") { Expand-Pkg "$Downloads\cudart.zip" $llamaDir }

    # 2. Qwen3-ASR 模型（Q8_0 主模型 768MB + mmproj 音频编码器 205MB）
    $hfBase = "https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/main"
    Get-File "$hfBase/Qwen3-ASR-0.6B-Q8_0.gguf"           "$llamaDir\Qwen3-ASR-0.6B-Q8_0.gguf"
    Get-File "$hfBase/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf"    "$llamaDir\mmproj-Qwen3-ASR-0.6B-Q8_0.gguf"

    Write-Host "`n[OK] 路线A 就绪: $llamaDir"
    Write-Host "     启动命令示例:"
    Write-Host "     .\llama-cpp\llama-server.exe -m .\llama-cpp\Qwen3-ASR-0.6B-Q8_0.gguf --mmproj .\llama-cpp\mmproj-Qwen3-ASR-0.6B-Q8_0.gguf --port 8931 $(if($Backend -eq 'cuda'){'-ngl 99'})"
}

# ──────────────────────────────────────────────
# 路线 B：sherpa-onnx + SenseVoice + VITS
# ──────────────────────────────────────────────
if (-not $SkipSherpa) {
    $sherpaDir = Join-Path $Root "sherpa-onnx"
    New-Item -ItemType Directory -Force -Path $sherpaDir | Out-Null

    # 1. 运行时（单文件 CLI：non-streaming-asr / non-streaming-tts）
    $ver = "1.13.6"
    $relBase = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
    if ($Backend -eq "cuda") {
        Get-File "$relBase/v$ver/sherpa-onnx-v$ver-cuda-12.x-cudnn-9.x-onnxruntime1.27.1-win-x64-cuda.tar.bz2" "$Downloads\sherpa-runtime.tar.bz2"
    } else {
        Get-File "$relBase/v$ver/sherpa-onnx-v$ver-win-x64.tar.bz2" "$Downloads\sherpa-runtime.tar.bz2"
    }
    Expand-Pkg "$Downloads\sherpa-runtime.tar.bz2" $sherpaDir

    # 2. SenseVoice 中文 ASR 模型（int8，约 230MB）
    Get-File "$relBase/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2" "$Downloads\sensevoice.tar.bz2"
    Expand-Pkg "$Downloads\sensevoice.tar.bz2" $sherpaDir

    # 3. VITS 中文 TTS 模型（aishell3，约 115MB）
    Get-File "$relBase/tts-models/vits-zh-aishell3.tar.bz2" "$Downloads\vits-aishell3.tar.bz2"
    Expand-Pkg "$Downloads\vits-aishell3.tar.bz2" $sherpaDir

    Write-Host "`n[OK] 路线B 就绪: $sherpaDir"
    Get-ChildItem $sherpaDir -Directory | ForEach-Object { Write-Host "     - $($_.Name)" }
}

Write-Host "`n========== 全部就绪，运行基准测试 =========="
Write-Host "  .\run-benchmark.ps1"
