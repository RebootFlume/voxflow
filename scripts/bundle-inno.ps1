# VoxFlow — InnoSetup 两遍打包
#
# 用法：
#   npm run bundle:inno                  → 完整两遍（Electron 文件版 + InnoSetup 安装包）
#   npm run bundle:inno -- -SkipBuild    → 跳过第一遍，复用已有 release\win-unpacked
#   npm run bundle:inno -- -OnlyElectron → 只跑第一遍（纯文件版），供人工确认
#
# ── 两遍是什么 ────────────────────────────────────────────────────────────
#   第一遍  electron-builder --dir  →  release\win-unpacked\（纯文件目录，无安装器）
#   第二遍  ISCC                    →  以第一遍产物为输入，产出安装包
#
# 顺序不能省：第二遍直接吃第一遍的目录。分两次跑时用 -OnlyElectron 确认第一遍完整，
# 再跑 -SkipBuild 做第二遍。
#
# ── 产物 ──────────────────────────────────────────────────────────────────
#   dist-inno\VoxFlow-Setup-<ver>.exe     安装版（InnoSetup 编译）
#   dist-inno\VoxFlow-Portable-<ver>.zip  便携版（目录直接压缩，解压即用）
#
#   两者根目录结构相同：
#     VoxFlow.exe   根目录启动器（csc 编译的壳，负责拉起 bin\ 下的 Electron）
#     bin\          Electron 本体
#     data\         数据根（便携版实际使用；安装版用 %APPDATA%）
#     libs\         推理运行时（按需下载）
#
# 不影响既有的 dist-bundle\（electron-builder 自带打包器那套）。

param(
    [switch]$SkipBuild,
    [switch]$OnlyElectron
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$pkg = Get-Content "$root\package.json" -Raw | ConvertFrom-Json
$ver = $pkg.version
$out = "$root\dist-inno"
$cache = "$root\.cache"
$unpacked = "$root\release\win-unpacked"

# ---------- 工具定位 ----------
function Find-Iscc {
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Inno Setup 7\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 7\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 7\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    throw "找不到 ISCC.exe（Inno Setup 编译器）。装 Inno Setup 6/7 后重试。"
}

function Find-Csc {
    # .NET Framework 4 自带编译器：系统组件，不引入外部依赖
    foreach ($p in @(
        "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
        "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
    )) { if (Test-Path $p) { return $p } }
    throw "找不到 csc.exe（.NET Framework 4）"
}

# ============================================================================
# 第一遍：Electron 自带的 electron-builder，只出纯文件目录
# ============================================================================
Write-Host "`n=== [1/3] 第一遍：electron-builder --dir（纯文件目录） ===" -ForegroundColor Cyan

if ($SkipBuild) {
    Write-Host "  -SkipBuild：跳过，复用现有 release\win-unpacked" -ForegroundColor DarkGray
} else {
    Push-Location $root
    # --dir 只产出解包目录；不传 --win 就不碰 nsis/dmg 那些安装器 target。
    # 直接调 cli.js 而不是 npx：这台机器 npm 的 shim 坏了（nvm 的 sh 脚本找不到 node）。
    & node "$root\node_modules\electron-builder\cli.js" --dir
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { Write-Error "electron-builder --dir 失败（退出码 $code）" }
}

if (-not (Test-Path "$unpacked\resources\app.asar")) {
    Write-Error "第一遍产物不完整：$unpacked\resources\app.asar 不存在"
}
$electronExe = Get-ChildItem "$unpacked" -Filter *.exe | Select-Object -First 1
if (-not $electronExe) { Write-Error "第一遍产物里没有 exe：$unpacked" }
Write-Host "  ✔ Electron: $($electronExe.Name) ($([math]::Round($electronExe.Length/1MB)) MB)" -ForegroundColor Green
Write-Host "  ✔ app.asar: $([math]::Round((Get-Item "$unpacked\resources\app.asar").Length/1MB)) MB" -ForegroundColor Green

if ($OnlyElectron) {
    Write-Host "`n-OnlyElectron：第一遍完成，未跑 InnoSetup。" -ForegroundColor Yellow
    Write-Host "  确认无误后执行： npm run bundle:inno -- -SkipBuild" -ForegroundColor Yellow
    return
}

# ============================================================================
# 编译根目录启动器（InnoSetup 的 exe 只是壳，Electron 在 bin\ 下）
# ============================================================================
Write-Host "`n=== [2/3] 编译根目录启动器 ===" -ForegroundColor Cyan
$csc = Find-Csc
if (-not (Test-Path $cache)) { New-Item $cache -ItemType Directory -Force | Out-Null }
$launcher = "$cache\VoxFlowLauncher.exe"
& $csc /nologo /target:winexe /optimize+ /out:"$launcher" "$root\scripts\inno\VoxFlowLauncher.cs"
if ($LASTEXITCODE -ne 0) { Write-Error "启动器编译失败" }
Write-Host "  ✔ $launcher ($([math]::Round((Get-Item $launcher).Length/1KB)) KB)" -ForegroundColor Green

if (-not (Test-Path $out)) { New-Item $out -ItemType Directory -Force | Out-Null }

# ============================================================================
# 第二遍 A：便携版 —— 直接组装目录再压缩，不经过 setup exe
# ============================================================================
Write-Host "`n=== [3/3] 第二遍：InnoSetup 安装版 + 便携版 ===" -ForegroundColor Cyan

$stage = "$out\_stage-portable"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item $stage -ItemType Directory -Force | Out-Null

# 根目录：启动器 + 便携标记
Copy-Item $launcher "$stage\VoxFlow.exe"
Copy-Item "$root\scripts\inno\portable.txt" "$stage\portable.txt"

# bin\：Electron 本体整体搬入
$stageBin = "$stage\bin"
New-Item $stageBin -ItemType Directory -Force | Out-Null
Copy-Item "$unpacked\*" $stageBin -Recurse -Force

# data\ 与 libs\：预建空目录（内容首次运行时按需生成）
New-Item "$stage\data\models" -ItemType Directory -Force | Out-Null
New-Item "$stage\libs" -ItemType Directory -Force | Out-Null

Write-Host "  → 便携版: VoxFlow-Portable-$ver.zip" -ForegroundColor Cyan
$zip = "$out\VoxFlow-Portable-$ver.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
# bsdtar（Windows 自带，System32\tar.exe）支持 zip，比 Compress-Archive 快得多
Push-Location $stage
& tar -a -c -f $zip *
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Write-Error "便携版压缩失败（退出码 $code）" }
Remove-Item $stage -Recurse -Force
Write-Host "  ✔ $zip ($([math]::Round((Get-Item $zip).Length/1MB)) MB)" -ForegroundColor Green

# ============================================================================
# 第二遍 B：安装版 —— ISCC 编译，产物仍是 setup exe
# ============================================================================
Write-Host "  → 安装版: VoxFlow-Setup-$ver.exe（ISCC 编译约 3 分钟）" -ForegroundColor Cyan
$iscc = Find-Iscc
& $iscc "/DAppVersion=$ver" "/DOutputBase=VoxFlow-Setup-$ver" "$root\scripts\inno\voxflow-installer.iss"
if ($LASTEXITCODE -ne 0) { Write-Error "ISCC 安装版失败（退出码 $LASTEXITCODE）" }

$setup = "$out\VoxFlow-Setup-$ver.exe"
Write-Host "  ✔ $setup ($([math]::Round((Get-Item $setup).Length/1MB)) MB)" -ForegroundColor Green

Write-Host "`n完成！产物在 dist-inno\" -ForegroundColor Green
Write-Host "  VoxFlow-Setup-$ver.exe      安装版（双击安装）" -ForegroundColor DarkGray
Write-Host "  VoxFlow-Portable-$ver.zip   便携版（解压即用）" -ForegroundColor DarkGray
Write-Host "  原有的 dist-bundle\ 未受影响" -ForegroundColor DarkGray
