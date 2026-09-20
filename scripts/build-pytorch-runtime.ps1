#requires -Version 5.1
<##
.SYNOPSIS
Builds one self-contained VoxFlow PyTorch runtime ZIP.

The output contains the CPython Windows embeddable runtime, pre-downloaded
PyTorch wheels and dependencies, worker.py, a manifest, and notices. The
application never runs pip on the user's machine.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("cpu", "cuda130")]
    [string]$Variant,
    [string]$Out = "",
    [string]$PythonVersion = "3.11.9",
    [string]$TorchVersion = "2.14.0",
    # 只重跑"装模型依赖 + vendor + smoke + 打包"，复用已解压的 runtime 目录
    [switch]$PackageOnly
)

# 模型适配层所需的额外 Python 包（显式清单 + 锁版本，不用 pip 的自动解析）。
#
# 为什么显式 + 锁版本：
# 1) pip 解析 `kokoro` 会带上 `misaki[en]` → spaCy + spacy-curated-transformers（约 +28 MiB，
#    纯为英文 G2P）。VoxFlow 的 PyTorch TTS 只用中文 G2P（misaki[zh]），且 Kokoro 推理代码
#    以 vendor 形式随运行时发布，故不装 kokoro 包本体、不装 spaCy。
# 2) 不锁版本会随 pip 镜像漂移（实测镜像落后 PyPI，且没上 kokoro 0.9.4），
#    运行时内容无法复现；版本以本文件为准。
$modelDeps = @(
    # ASR：Whisper via transformers
    "transformers==5.17.0", "tokenizers==0.23.2", "huggingface_hub==1.32.0", "safetensors==0.8.0",
    "regex==2026.9.10", "pyyaml==6.0.3", "requests==2.34.2", "charset_normalizer==3.5.1",
    "idna==3.20", "urllib3==2.8.0", "certifi==2026.7.22", "tqdm==4.70.1", "packaging==26.3",
    "httpx==0.28.1", "httpcore==1.0.9", "h11==0.16.0", "anyio==4.15.1", "sniffio==1.3.1",
    # TTS：misaki[zh] 中文 G2P + Kokoro 运行时依赖
    "misaki==0.9.4", "addict==2.4.0", "pypinyin==0.55.0", "pypinyin_dict==0.9.0", "cn2an==0.5.24",
    "ordered_set==4.1.0", "proces==0.1.7", "loguru==0.7.3", "colorama==0.4.6",
    "win32_setctime==1.2.0", "num2words==0.5.14", "attrs==26.1.0",
    # kokoro/model.py 依赖的上游包（KModel 用到 AlbertConfig / hf_hub_download）
    "typer==0.27.2", "click==8.5.0"
)
# 只发 sdist 的纯 Python 包（无 wheel 发布）：版本 + 需要复制进 site-packages 的顶层条目
$sdistOnly = @(
    @{ spec = "jieba==0.42.1"; copies = @("jieba") },
    @{ spec = "docopt==0.6.2"; copies = @("docopt.py") }
)
# 依赖从 PyPI 直连取（镜像会漂移/缺版本）；torch 仍走 pytorch 官方 index
$modelDepIndex = "https://pypi.org/simple"
# vendor 的 Kokoro 推理代码（Apache-2.0）：源版本 + 需要取出的文件 + 源码地址
$kokoroPin = "kokoro==0.9.4"
$kokoroFiles = @("model.py", "istftnet.py", "modules.py", "custom_stft.py")
$kokoroIndex = "https://pypi.org/simple"

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
if (-not $Out) { $Out = Join-Path $root "dist-bundle\pytorch-runtime" }
$variantLabel = $Variant
$torchSuffix = if ($Variant -eq "cuda130") { "cu130" } else { "cpu" }
$torchSpec = "$TorchVersion+$torchSuffix"
$indexUrl = if ($Variant -eq "cpu") { "https://download.pytorch.org/whl/cpu" } else { "https://download.pytorch.org/whl/cu130" }
$assetName = "voxflow-pytorch-$Variant-py311-torch$TorchVersion-win-x64.zip"
$work = Join-Path $Out "_work-$Variant"
$downloads = Join-Path $work "downloads"
$runtime = Join-Path $work "runtime"
$zip = Join-Path $Out $assetName

function Require-Command([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "Required command not found: $Name" }
    return $cmd.Source
}

$python = Require-Command "python"
$curl = Require-Command "curl.exe"
$sevenZip = $null
$sevenZipCandidates = @("$env:ProgramFiles\7-Zip\7z.exe", "${env:ProgramFiles(x86)}\7-Zip\7z.exe", "D:\app\7-Zip\7z.exe")
foreach ($candidate in $sevenZipCandidates) { if (Test-Path $candidate) { $sevenZip = $candidate; break } }
if (-not $sevenZip) { throw "Required command not found: 7z.exe" }
New-Item -ItemType Directory -Force -Path $Out, $downloads, $runtime | Out-Null
if (-not $PackageOnly) {
    if (Test-Path $work) { Remove-Item $work -Recurse -Force; New-Item -ItemType Directory -Force -Path $downloads, $runtime | Out-Null }

    $embedZip = Join-Path $downloads "python-$PythonVersion-embed-amd64.zip"
    $embedUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
    Write-Host "Downloading CPython embeddable runtime: $embedUrl"
    & $curl -fL --retry 4 --retry-delay 2 -o $embedZip $embedUrl
    if ($LASTEXITCODE -ne 0) { throw "Failed to download CPython embeddable runtime" }
    Expand-Archive -LiteralPath $embedZip -DestinationPath $runtime -Force

    # The embeddable distribution disables site-packages by default. Keep its
    # standard paths and enable site so torch dependencies are importable.
    $pth = Get-ChildItem $runtime -Filter "*_._pth" | Select-Object -First 1
    if (-not $pth) { $pth = Get-ChildItem $runtime -Filter "*_pth" | Select-Object -First 1 }
    if (-not $pth) { throw "CPython embeddable package has no _pth file" }
    $pthLines = @(
        "."
        "python311.zip"
        "Lib/site-packages"
        "import site"
    )
    [IO.File]::WriteAllLines($pth.FullName, $pthLines, (New-Object Text.UTF8Encoding($false)))

    Write-Host "Downloading PyTorch $torchSpec and binary dependencies for CPython 3.11"
    & $python -m pip download `
        --disable-pip-version-check `
        --only-binary=:all: `
        --python-version 3.11 `
        --platform win_amd64 `
        --implementation cp `
        --abi cp311 `
        --dest $downloads `
        --index-url $indexUrl `
        --extra-index-url https://pypi.org/simple `
        "torch==$torchSpec" "numpy"
    if ($LASTEXITCODE -ne 0) { throw "Failed to download torch $torchSpec for CPython 3.11" }
    if (Get-ChildItem $downloads -Filter "*-cp313-*.whl" -ErrorAction SilentlyContinue) {
        throw "Downloaded a CPython 3.13 wheel; refusing to build a Python 3.11 runtime"
    }

    $site = Join-Path $runtime "Lib\site-packages"
    New-Item -ItemType Directory -Force -Path $site | Out-Null
    $wheels = Get-ChildItem $downloads -Filter "*.whl"
    if (-not $wheels) { throw "No Python wheels downloaded" }
    foreach ($wheel in $wheels) {
        Write-Host "Extracting $($wheel.Name)"
        Expand-Archive -LiteralPath $wheel.FullName -DestinationPath $site -Force
    }
}

$site = Join-Path $runtime "Lib\site-packages"
if (-not (Test-Path $site)) { throw "site-packages 不存在：先跑一次完整构建（去掉 -PackageOnly）" }

# ── 模型适配层依赖（锁版本；见文件头注释为何不用 pip 自动解析）──
Write-Host "Downloading model-adapter dependencies for CPython 3.11"
$depDir = Join-Path $work "model-deps"
New-Item -ItemType Directory -Force -Path $depDir | Out-Null
& $python -m pip download `
    --disable-pip-version-check `
    --no-deps `
    --only-binary=:all: `
    --python-version 3.11 `
    --platform win_amd64 `
    --implementation cp `
    --abi cp311 `
    --index-url $modelDepIndex `
    --dest $depDir `
    $modelDeps
if ($LASTEXITCODE -ne 0) { throw "Failed to download model-adapter binary deps" }
foreach ($item in $sdistOnly) {
    & $python -m pip download --disable-pip-version-check --no-deps --no-binary=:all: `
        --index-url $modelDepIndex --dest $depDir $item.spec
    if ($LASTEXITCODE -ne 0) { throw "Failed to download sdist $($item.spec)" }
}
foreach ($wheel in Get-ChildItem $depDir -Filter "*.whl") {
    Write-Host "Extracting $($wheel.Name)"
    Expand-Archive -LiteralPath $wheel.FullName -DestinationPath $site -Force
}
# 纯 Python sdist：只复制"可导入的顶层条目"（包目录 / 同名模块），
# 不把 sdist 自带的 setup.py / README / test / egg-info 之类元数据倒进 site-packages。
# 不假设解压层数：直接从解压结果里递归定位目标条目。
foreach ($item in $sdistOnly) {
    $sdist = Get-ChildItem $depDir -Filter "*.tar.gz" |
        Where-Object { $_.Name -like ($item.spec.Split('==')[0] + '-*') } | Select-Object -First 1
    if (-not $sdist) { throw "sdist not found for $($item.spec)" }
    $inner = Join-Path $depDir ($sdist.BaseName -replace '\.tar$', '')
    if (Test-Path $inner) { Remove-Item $inner -Recurse -Force }
    & $sevenZip x $sdist.FullName "-o$inner" -y | Out-Null
    # 7z 对 .tar.gz 只解开压缩层（留下内层 .tar，位置不固定，必须递归找），继续解一层拿到文件树
    $tar = Get-ChildItem $inner -Recurse -Filter "*.tar" -File | Select-Object -First 1
    if (-not $tar) { throw "$($sdist.Name) 解压后找不到内层 tar" }
    & $sevenZip x $tar.FullName "-o$inner" -y | Out-Null
    Remove-Item $tar.FullName -Force
    foreach ($name in $item.copies) {
        $src = Get-ChildItem $inner -Recurse | Where-Object { $_.Name -eq $name } |
            Sort-Object { $_.FullName.Length } | Select-Object -First 1
        if (-not $src) { throw "$($sdist.Name) 里找不到 $name" }
        $dest = Join-Path $site $name
        if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
        if ($src.PSIsContainer) { Copy-Item $src.FullName $dest -Recurse -Force }
        else { Copy-Item $src.FullName $dest -Force }
    }
}
if (Get-ChildItem $site -Filter "*cp313*" -ErrorAction SilentlyContinue) {
    throw "site-packages 混入 CPython 3.13 产物"
}

# ── vendor Kokoro 推理代码（Apache-2.0；只用 KModel，不引入上游 pipeline 的 spaCy 链）──
Write-Host "Vendoring Kokoro inference code ($kokoroPin)"
$kdir = Join-Path $work "kokoro"
New-Item -ItemType Directory -Force -Path $kdir | Out-Null
& $python -m pip download --disable-pip-version-check --no-deps --only-binary=:all: `
    --python-version 3.11 --platform win_amd64 --implementation cp --abi cp311 `
    --index-url $kokoroIndex --dest $kdir $kokoroPin
# 注意：kokoro 声明 Requires-Python >=3.10,<3.13；构建机可能是 3.13，
# 不显式指定目标解释器时 pip 会拒装 0.9.4（实测踩过）
if ($LASTEXITCODE -ne 0) { throw "Failed to download $kokoroPin" }
$kwhl = Get-ChildItem $kdir -Filter "kokoro-*.whl" | Select-Object -First 1
if (-not $kwhl) { throw "kokoro wheel not found" }
$kextract = Join-Path $kdir "x"
if (Test-Path $kextract) { Remove-Item $kextract -Recurse -Force }
Expand-Archive -LiteralPath $kwhl.FullName -DestinationPath $kextract -Force
$kpkg = Join-Path $site "voxflow_kokoro"
if (Test-Path $kpkg) { Remove-Item $kpkg -Recurse -Force }
New-Item -ItemType Directory -Force -Path $kpkg | Out-Null
foreach ($f in $kokoroFiles) {
    Copy-Item (Join-Path $kextract "kokoro\$f") (Join-Path $kpkg $f) -Force
}
# 上游 istftnet.py 用绝对导入 `from kokoro.custom_stft ...`，vendor 后改为相对导入
$istft = Join-Path $kpkg "istftnet.py"
$istftText = [IO.File]::ReadAllText($istft)
$istftText = $istftText.Replace("from kokoro.custom_stft import CustomSTFT", "from .custom_stft import CustomSTFT")
[IO.File]::WriteAllText($istft, $istftText, (New-Object Text.UTF8Encoding($false)))
$klLicense = Get-ChildItem $kextract -Recurse -Filter "LICENSE" | Select-Object -First 1
if ($klLicense) { Copy-Item $klLicense.FullName (Join-Path $kpkg "LICENSE-kokoro.txt") -Force }
$kinit = @"
"""Vendored Kokoro-82M inference code (Apache-2.0).

Source: $kokoroPin
Vendored files: $($kokoroFiles -join ' / ')

Why vendored instead of depending on the upstream package: `kokoro` imports
`kokoro.pipeline` -> `misaki.en` -> spaCy + spacy-curated-transformers (~28 MiB)
purely for English G2P. VoxFlow's PyTorch TTS path uses `misaki.zh` only, so
vendoring KModel keeps the runtime small and the dependency surface explicit.
"""
from .model import KModel

__all__ = ["KModel"]
"@
[IO.File]::WriteAllText((Join-Path $kpkg "__init__.py"), $kinit, (New-Object Text.UTF8Encoding($false)))

Copy-Item (Join-Path $root "runtime\pytorch\worker.py") (Join-Path $runtime "worker.py") -Force
$notices = Join-Path $runtime "THIRD_PARTY_NOTICES"
New-Item -ItemType Directory -Force -Path $notices | Out-Null
$noticeText = @"
VoxFlow PyTorch runtime

Variant: $variantLabel
Python: $PythonVersion
PyTorch: $torchSpec

This archive contains redistributed CPython and Python wheel packages.
Upstream sources:
- CPython: https://www.python.org/downloads/release/python-3119/
- PyTorch: https://pytorch.org/
- PyTorch wheel index: $indexUrl
- Model adapters (ASR): https://huggingface.co/docs/transformers (Whisper)
- Model adapters (TTS): misaki[zh] G2P + vendored Kokoro-82M inference code
  ($kokoroPin, Apache-2.0, see Lib/site-packages/voxflow_kokoro/LICENSE-kokoro.txt)

License texts are included in the corresponding *.dist-info directories when
provided by the upstream wheel. Keep this file with the runtime archive.
"@
[IO.File]::WriteAllText((Join-Path $notices "README.txt"), $noticeText, (New-Object Text.UTF8Encoding($false)))

$cuda = if ($Variant -eq "cuda130") { "13.0" } else { $null }
$manifest = [ordered]@{
    framework = "pytorch-python"
    variant = $variantLabel
    python = $PythonVersion
    torch = $torchSpec
    torchaudio = $null
    cuda = $cuda
    arch = "x86_64-pc-windows-msvc"
    worker_protocol = 1
    entry = "python.exe"
    script = "worker.py"
    smoke_test = "python.exe worker.py --smoke-test"
    # 运行时内置的模型适配器（worker 只接受这份白名单里的 id；模型目录不得携带可执行代码）
    adapters = @("whisper", "kokoro")
    asset = $assetName
    status = "built"
}
$manifestPath = Join-Path $runtime "runtime-manifest.json"
# Windows PowerShell 5.1 的 Set-Content -Encoding utf8 会写 BOM；必须无 BOM 写入
[IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 4),
    (New-Object Text.UTF8Encoding($false))
)

$pythonExe = Join-Path $runtime "python.exe"
Write-Host "Running runtime smoke test"
& $pythonExe (Join-Path $runtime "worker.py") --smoke-test
if ($LASTEXITCODE -ne 0) { throw "Runtime smoke test failed for $Variant" }

if (Test-Path $zip) { Remove-Item $zip -Force }
$auxZip = Join-Path $Out "voxflow-pytorch-$Variant-cuda13-libs.zip"
$a = @()
$b = @()
if ($Variant -eq 'cuda130') {
    # CUDA 运行库单独成片（29 个 DLL）。torch 在 import 时预加载 torch/lib 下全部 DLL，
    # 缺任何一个被引用的都会让 import torch 失败 → 辅包必须与主包一起安装。
    $libDir = Join-Path $runtime "Lib\site-packages\torch\lib"
    $auxNames = @(Get-ChildItem $libDir -Filter *.dll |
        Where-Object {
            $n = $_.Name.ToLowerInvariant()
            $n.StartsWith('cublas') -or $n.StartsWith('cudnn') -or $n.StartsWith('cufft') -or
            $n.StartsWith('cudart') -or $n.StartsWith('cupti') -or $n.StartsWith('curand') -or
            $n.StartsWith('cusolver') -or $n.StartsWith('cusparse') -or $n.StartsWith('nvjitlink') -or
            $n.StartsWith('nvrtc') -or $n.StartsWith('nvperf') -or $n.StartsWith('nvtoolsext') -or
            $n.StartsWith('caffe2_nvrtc') -or $n -eq 'torch_cuda.dll' -or $n -eq 'c10_cuda.dll'
        } | ForEach-Object { $_.Name })
    if ($auxNames.Count -lt 20) { throw "CUDA aux DLL set looks wrong: $($auxNames.Count) files" }
    $exclude = $auxNames | ForEach-Object { "-x!Lib/site-packages/torch/lib/$_" }
    Push-Location $runtime
    & $sevenZip a -tzip -mx=5 -mmt=on $zip * @exclude | Out-Null
    $rcMain = $LASTEXITCODE
    Pop-Location
    if (Test-Path $auxZip) { Remove-Item $auxZip -Force }
    Push-Location $libDir
    & $sevenZip a -tzip -mx=5 -mmt=on $auxZip @auxNames | Out-Null
    $rcAux = $LASTEXITCODE
    Pop-Location
    if ($rcMain -ne 0 -or $rcAux -ne 0) { throw "Failed to create split CUDA archives" }
    $a = @{ name = Split-Path $auxZip -Leaf; bytes = (Get-Item $auxZip).Length;
            sha256 = ((& sha256sum $auxZip | Select-Object -First 1).ToString() -split '\s+')[0].ToLowerInvariant() }
} else {
    Push-Location $runtime
    & $sevenZip a -tzip -mx=5 -mmt=on $zip * | Out-Null
    $zipExit = $LASTEXITCODE
    Pop-Location
    if ($zipExit -ne 0) { throw "Failed to create runtime archive" }
}
$hashLine = (& sha256sum $zip | Select-Object -First 1).ToString()
if (-not $hashLine) { throw "Could not calculate SHA-256 for $zip" }
$hash = ($hashLine -split "\s+")[0].ToLowerInvariant()
$size = (Get-Item $zip).Length
$metadata = [ordered]@{ asset = $assetName; variant = $Variant; sha256 = $hash; bytes = $size;
                        torch = $torchSpec; python = $PythonVersion; aux = ($(if ($a) { $a } else { $null })) }
$metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Out "$assetName.json") -Encoding utf8
Write-Host "Built: $zip" -ForegroundColor Green
Write-Host "SHA-256: $hash" -ForegroundColor Cyan
Write-Host "Bytes: $size" -ForegroundColor Cyan
if ($a) { Write-Host "Aux: $($a.name) $($a.bytes) $($a.sha256)" -ForegroundColor Green }
