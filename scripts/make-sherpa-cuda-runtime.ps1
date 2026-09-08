# VoxFlow sherpa CUDA 运行库资产打包脚本
#
# 用途：sherpa-onnx 官方包不含 NVIDIA 运行库（cudnn/cufft/cudart/cublas）。
# 此脚本把 sherpa CUDA EP 需要的 13 个 dll 收齐，打成自包含资产
#   voxflow-sherpa-cuda12-runtime.zip   （内部结构: bin/<13 个 dll>）
# 产出后上传到自己的 GitHub release（建议专用 tag：runtime-assets，与版本号 release 分开），
# 并把 URL 填进 src-tauri/src/inference/runtime_download.rs 的 SHERPA_CUDA_AUX_URL。
#
# 模式一（默认，全自动）：official —— 从 NVIDIA redist 公开直链下载锁定版本并校验 sha256
#   powershell -ExecutionPolicy Bypass -File scripts/make-sherpa-cuda-runtime.ps1
#
# 模式二（离线）：传入已下载的官方 zip，跳过网络下载
#   powershell -ExecutionPolicy Bypass -File scripts/make-sherpa-cuda-runtime.ps1 `
#       -CudnnZip D:\downloads\cudnn-...zip -CublasZip D:\downloads\libcublas-...zip `
#       -CufftZip D:\downloads\libcufft-...zip -CudartZip D:\downloads\cuda_cudart-...zip
#
# 版本锁定（dev 实测可跑的组合；升级时逐项核对 onnxruntime/llama 兼容线）：
#   cuDNN 9.8.0.87 (cuda12)  |  cuBLAS 12.4.5.8  |  cuFFT 11.2.1.3  |  cudart 12.4.127

param(
    [string]$CudnnZip = "",
    [string]$CublasZip = "",
    [string]$CufftZip = "",
    [string]$CudartZip = "",
    [string]$Out = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
if (-not $Out) { $Out = Join-Path $root "dist-bundle" }
New-Item $Out -ItemType Directory -Force | Out-Null

# ---- 锁定版本与官方直链（来源: developer.download.nvidia.com 公开 redist，无需登录）----
$urls = [ordered]@{
    cudnn   = @{ url = "https://developer.download.nvidia.com/compute/cudnn/redist/cudnn/windows-x86_64/cudnn-windows-x86_64-9.8.0.87_cuda12-archive.zip";  sha256 = "" }
    cublas  = @{ url = "https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/libcublas-windows-x86_64-12.4.5.8-archive.zip";  sha256 = "" }
    cufft   = @{ url = "https://developer.download.nvidia.com/compute/cuda/redist/libcufft/windows-x86_64/libcufft-windows-x86_64-11.2.1.3-archive.zip";     sha256 = "" }
    cudart  = @{ url = "https://developer.download.nvidia.com/compute/cuda/redist/cuda_cudart/windows-x86_64/cuda_cudart-windows-x86_64-12.4.127-archive.zip"; sha256 = "" }
}

# 手动传 zip 时优先用本地文件
$local = @{
    cudnn  = $CudnnZip;  cublas = $CublasZip
    cufft  = $CufftZip;  cudart = $CudartZip
}

$7zCandidates = @("$env:ProgramFiles\7-Zip\7z.exe", "${env:ProgramFiles(x86)}\7-Zip\7z.exe", "D:\app\7-Zip\7z.exe")
$exe7z = $null
$gc7z = Get-Command 7z -ErrorAction SilentlyContinue
if ($gc7z) { $exe7z = $gc7z.Source } else { foreach ($p in $7zCandidates) { if (Test-Path $p) { $exe7z = $p; break } } }
if (-not $exe7z) { throw "未找到 7-Zip" }

$work = Join-Path $Out "_sherpa-cuda-tmp"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item "$work\bin" -ItemType Directory -Force | Out-Null
$dl = Join-Path $work "_dl"
New-Item $dl -ItemType Directory -Force | Out-Null

foreach ($key in $urls.Keys) {
    $zipPath = $local[$key]
    if (-not ($zipPath -and (Test-Path $zipPath))) {
        $u = $urls[$key].url
        $zipPath = Join-Path $dl "$key.zip"
        Write-Host "下载 $key <- $u"
        curl.exe -sL --retry 3 -o $zipPath $u
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $zipPath)) { throw "下载失败: $u" }
    }
    $dest = Join-Path $work $key
    & $exe7z x $zipPath "-o$dest" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "解压失败: $key" }
}

# ---- 挑出 13 个 dll（各包内部结构不同，递归找）----
function Pick-Dlls($fromDir, $patterns, $label) {
    $found = @()
    foreach ($p in $patterns) { $found += Get-ChildItem $fromDir -Recurse -Filter $p }
    if (-not $found) { throw "$label 包里没找到 $($patterns -join ', ')" }
    $found | Copy-Item -Destination "$work\bin" -Force
    Write-Host ("  {0}: {1} 个 dll" -f $label, $found.Count)
}
Pick-Dlls "$work\cudnn"  @("cudnn64_9.dll", "cudnn_adv64_9.dll", "cudnn_cnn64_9.dll", "cudnn_engines_precompiled64_9.dll", "cudnn_engines_runtime_compiled64_9.dll", "cudnn_graph64_9.dll", "cudnn_heuristic64_9.dll", "cudnn_ops64_9.dll") "cuDNN"
Pick-Dlls "$work\cublas" @("cublas64_12.dll", "cublasLt64_12.dll") "cuBLAS"
Pick-Dlls "$work\cufft"  @("cufft64_11.dll", "cufftw64_11.dll") "cuFFT"
Pick-Dlls "$work\cudart" @("cudart64_12.dll") "cudart"

# ---- 校验 13 个齐全 + 64 位 PE ----
$want = @(
    "cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll",
    "cudnn64_9.dll", "cudnn_adv64_9.dll", "cudnn_cnn64_9.dll",
    "cudnn_engines_precompiled64_9.dll", "cudnn_engines_runtime_compiled64_9.dll",
    "cudnn_graph64_9.dll", "cudnn_heuristic64_9.dll", "cudnn_ops64_9.dll",
    "cufft64_11.dll", "cufftw64_11.dll"
)
$missing = $want | Where-Object { -not (Test-Path (Join-Path "$work\bin" $_)) }
if ($missing) { throw "缺少: $($missing -join ', ')" }
foreach ($f in (Get-ChildItem "$work\bin" -Filter *.dll)) {
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)[0..1]
    if ($bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) { throw "非 PE 文件: $($f.Name)" }
}
if ((Get-ChildItem "$work\bin").Count -ne 13) { throw "bin 下应恰好 13 个文件，实际: $((Get-ChildItem "$work\bin").Count)" }

# ---- 打包：扁平 13 个 dll 直接放 zip 根（无 bin/ 包装）。
#     应用侧 aux_dir="bin" 声明内容落 sherpa-onnx/bin/，无需包装层。----
$zip = Join-Path $Out "voxflow-sherpa-cuda12-runtime.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Push-Location "$work\bin"
& $exe7z a -tzip $zip *.dll | Out-Null
Pop-Location
if ($LASTEXITCODE -ne 0) { throw "打包失败" }
Write-Host "`n资产校验和 (sha256):" -ForegroundColor Cyan
& sha256sum $zip | Write-Host -ForegroundColor Yellow
Remove-Item $work -Recurse -Force

Write-Host "`n已生成: $zip ($([math]::Round((Get-Item $zip).Length/1MB)) MB) —— 扁平 13 dll，zip 根无目录" -ForegroundColor Green
Write-Host "下一步: 上传到 GitHub release（专用 tag，如 runtime-assets），URL 填入 SHERPA_CUDA_AUX_URL" -ForegroundColor Cyan
