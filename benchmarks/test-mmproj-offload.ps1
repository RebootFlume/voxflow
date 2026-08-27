# 对比 mmproj 在 CPU vs GPU 时的显存占用
param(
    [string]$LlamaDir = "D:\app\ai\VoxFlow-Portable-0.1.0\libs\llama-cpp",
    [string]$ModelDir = "D:\app\ai\VoxFlow-Portable-0.1.0\data\models\Qwen3-ASR-1.7B",
    [int]$Port = 8931
)

$model  = Join-Path $ModelDir "Qwen3-ASR-1.7B-Q8_0.gguf"
$mmproj = Join-Path $ModelDir "mmproj-Qwen3-ASR-1.7B-bf16.gguf"
$server = Join-Path $LlamaDir "llama-server.exe"

function Get-VRam { (nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits).Trim() }
function Wait-Health($port) {
    foreach ($i in 1..30) {
        Start-Sleep -Seconds 2
        try { $r = curl.exe -s --max-time 2 "http://127.0.0.1:$port/health" 2>$null; if ($r -match 'ok') { return $true } } catch {}
    }
    return $false
}

# --- 测试1: 默认（mmproj 在 GPU）---
Write-Host "== 测试 1: mmproj-offload (默认, GPU) ==" -ForegroundColor Cyan
$vr0 = Get-VRam; Write-Host "  加载前显存: ${vr0} MB"
$proc = Start-Process -FilePath $server -ArgumentList @("-m", $model, "--mmproj", $mmproj, "--port", $Port, "-ngl", "99", "--ctx-size", "8192", "--parallel", "1", "--temp", "0", "--no-webui", "--mmproj-offload") -PassThru -WindowStyle Hidden
$ok = Wait-Health $Port
$vr1 = Get-VRam
Write-Host "  加载后显存: ${vr1} MB (增量: $([int]$vr1 - [int]$vr0) MB)"
Write-Host "  健康检查: $ok"
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3

# --- 测试2: mmproj 强制 CPU ---
Write-Host "`n== 测试 2: no-mmproj-offload (CPU) ==" -ForegroundColor Cyan
$vr0 = Get-VRam; Write-Host "  加载前显存: ${vr0} MB"
$proc = Start-Process -FilePath $server -ArgumentList @("-m", $model, "--mmproj", $mmproj, "--port", $Port, "-ngl", "99", "--ctx-size", "8192", "--parallel", "1", "--temp", "0", "--no-webui", "--no-mmproj-offload") -PassThru -WindowStyle Hidden
$ok = Wait-Health $Port
$vr2 = Get-VRam
Write-Host "  加载后显存: ${vr2} MB (增量: $([int]$vr2 - [int]$vr0) MB)"
Write-Host "  健康检查: $ok"
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3

# --- 对比 ---
Write-Host "`n========== 对比 ==========" -ForegroundColor Yellow
Write-Host "  mmproj-offload (GPU): ${vr1} MB"
Write-Host "  no-mmproj-offload (CPU): ${vr2} MB"
Write-Host "  差值: $([int]$vr1 - [int]$vr2) MB"
Write-Host "  mmproj bf16 文件大小: $([math]::Round((Get-Item $mmproj).Length / 1MB)) MB"
