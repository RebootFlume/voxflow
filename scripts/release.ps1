# VoxFlow 一键发版脚本
# 用法：
#   npm run release                → 打包 + 推送 + 建 release（notes 用 git 最近提交信息）
#   npm run release -- "自定义 notes"
#
# 前置：版本号已用 version:sync 统一 + 代码改动已 git add/commit（或本脚本帮你提交）
# 步骤：1) 打包(bundle.ps1 产 portable+setup) 2) git push 3) gh release create + upload
# 注意：远程已存在的 release(runtime-assets 等)不受影响

param(
    [string]$Notes = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

# 1. 版本 = package.json（事实源）
$pkg = Get-Content "$root\package.json" -Raw | ConvertFrom-Json
$ver = $pkg.version
Write-Host "`n=== 发版 v$ver ===" -ForegroundColor Cyan

# 1.5 校验：tauri.conf.json / Cargo.toml 版本一致（防漏改）
$tauriVer = (Get-Content "$root\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
if ($tauriVer -ne $ver) {
    Write-Error "版本不一致: package.json=$ver vs tauri.conf.json=$tauriVer —— 先跑 npm run version:sync"
}
Write-Host "版本一致 ✓ (package.json = tauri.conf.json = $ver)"

# 2. 打包（产物: VoxFlow-Portable-$ver.zip + VoxFlow-Setup-$ver.exe）
& powershell -ExecutionPolicy Bypass -File "$root\scripts\bundle.ps1"
if ($LASTEXITCODE -ne 0) { Write-Error "打包失败" }

$zip = "$root\dist-bundle\VoxFlow-Portable-$ver.zip"
$exe = "$root\dist-bundle\VoxFlow-Setup-$ver.exe"
if (-not (Test-Path $zip) -or -not (Test-Path $exe)) {
    Write-Error "产物缺失: 期望 $zip / $exe"
}

# 3. git 提交 + 推送（版本号改动若未提交则一并提交）
Push-Location $root
$dirty = git status --porcelain
if ($dirty) {
    git add -A
    git commit -m "release: v$ver"
}
git push origin master
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "git push 失败" }
Pop-Location

# 4. release notes（缺省 = 最近提交信息）
if ([string]::IsNullOrWhiteSpace($Notes)) {
    Push-Location $root
    $Notes = git log -1 --pretty=%B
    Pop-Location
}

# 5. gh release（同名已存在则更新资产，避免重复建）
gh release view "v$ver" --repo RebootFlume/voxflow 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "release v$ver 已存在 → 更新资产" -ForegroundColor Yellow
    gh release upload "v$ver" $zip $exe --repo RebootFlume/voxflow --clobber
} else {
    gh release create "v$ver" --repo RebootFlume/voxflow --title "v$ver" --notes $Notes
    gh release upload "v$ver" $zip $exe --repo RebootFlume/voxflow --clobber
}

Write-Host "`n=== 发版 v$ver 完成 ===" -ForegroundColor Green
