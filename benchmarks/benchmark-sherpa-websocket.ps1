# ============================================================
# sherpa-onnx SenseVoice WebSocket 常驻服务基准测试
# sherpa websocket server 接收二进制 PCM 音频（8000/16000 Hz mono int16）
# 响应是 JSON 字符串 {"text":"..."}  消息帧为 binary/text
# ============================================================
param(
    [int]$Port = 9002
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$BIN  = Join-Path $Root "sherpa-onnx\sherpa-onnx-v1.13.6-cuda-12.x-cudnn-9.x-onnxruntime1.27.1-win-x64-cuda\bin\sherpa-onnx-offline-websocket-server.exe"
$MODEL   = Join-Path $Root "sherpa-onnx\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17\model.int8.onnx"
$TOKENS  = Join-Path $Root "sherpa-onnx\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17\tokens.txt"
$WavDir  = Join-Path $Root "test-audio"
$LogOut  = Join-Path $Root "sherpa-ws.log"
$LogErr  = Join-Path $Root "sherpa-ws.err"

# ---------- 清理旧实例 ----------
Get-Process -Name "sherpa-onnx-offline-websocket-server" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "[清理] 停止旧服务 PID $($_.Id)"
    Stop-Process -Id $_.Id -Force
}
Start-Sleep 1

# ---------- 启动服务 ----------
Write-Host "== 启动 sherpa-onnx websocket 服务 (SenseVoice, CUDA) ==" -ForegroundColor Cyan

Remove-Item $LogOut, $LogErr -Force -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $BIN `
    -ArgumentList "--sense-voice-model=$MODEL","--tokens=$TOKENS","--provider=cuda","--port=$Port" `
    -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $LogOut `
    -RedirectStandardError $LogErr

Write-Host "  PID: $($proc.Id)，等待就绪..."
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep 1
    if ($proc.HasExited) {
        Write-Host "[错误] 进程退出 ($($proc.ExitCode))" -ForegroundColor Red
        Get-Content $LogErr | Select-Object -Last 10
        exit 1
    }
    $conn = Test-NetConnection -ComputerName "127.0.0.1" -Port $Port -WarningAction SilentlyContinue -InformationLevel Quiet
    if ($conn) { $ready = $true; break }
}
if (-not $ready) { throw "[错误] 服务启动超时" }
Write-Host "  就绪"

# ---------- 工具：读 PCM 数据 ----------
function Read-Pcm {
    param([string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $sr = [BitConverter]::ToUInt32($bytes, 24)
    # 找 "data" chunk
    $p = 12
    $dataOff = 0
    while ($p -lt $bytes.Length - 8) {
        $ck = [Text.Encoding]::ASCII.GetString($bytes, $p, 4)
        $sz = [BitConverter]::ToInt32($bytes, $p+4)
        if ($ck -eq "data") { $dataOff = $p + 8; break }
        $p += 8 + $sz
    }
    $pcm = $bytes[$dataOff..($bytes.Length-1)]
    return @{ pcm = $pcm; sr = $sr }
}

function Get-Duration {
    param([string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $sr = [BitConverter]::ToUInt32($bytes, 24)
    return [Math]::Round(($bytes.Length - 44) / 2 / $sr, 3)
}

# ---------- WebSocket 发送 PCM ----------
function Send-WsPcm {
    param([byte[]]$Pcm, [int]$TimeoutSec = 60)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $ws = New-Object System.Net.WebSockets.ClientWebSocket
        $ct = [Threading.CancellationToken]::None
        $ws.ConnectAsync("ws://127.0.0.1:$Port/", $ct).Wait($TimeoutSec * 1000)
        if ($ws.State -ne 'Open') { $sw.Stop(); return @{ ms=-1; text="连接失败:$($ws.State)"; ok=$false } }

        $ws.SendAsync([ArraySegment[byte]]$Pcm, [System.Net.WebSockets.WebSocketMessageType]::Binary, $true, $ct).Wait($TimeoutSec * 1000)

        $buf = [byte[]]::new(65536)
        $result = $ws.ReceiveAsync([ArraySegment[byte]]$buf, $ct)
        if (-not $result.Wait($TimeoutSec * 1000)) {
            $sw.Stop(); $ws.CloseAsync('NormalClosure', "", $ct).Wait(1000)
            return @{ ms=$sw.ElapsedMilliseconds; text="响应超时"; ok=$false }
        }
        $resp = [Text.Encoding]::UTF8.GetString($buf, 0, $result.Result.Count)
        $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "done", $ct).Wait(1000)
        $sw.Stop()
        try {
            $obj = $resp | ConvertFrom-Json
            $txt = $null
            if ($obj.text) { $txt = $obj.text }
            elseif ($obj.result) { $txt = $obj.result }
            elseif ($obj.partial) { $txt = $obj.partial }
            if ($null -eq $txt) { $txt = $resp }
            return @{ ms=$sw.ElapsedMilliseconds; text=[string]$txt; ok=$true }
        } catch {
            return @{ ms=$sw.ElapsedMilliseconds; text=$resp; ok=$true }
        }
    } catch {
        $sw.Stop()
        return @{ ms=$sw.ElapsedMilliseconds; text=$_.Exception.Message; ok=$false }
    }
}

# ---------- 跑测试 ----------
$wavs = @(
    @{ name="short";  path=Join-Path $WavDir "tts-short.wav"  },
    @{ name="medium"; path=Join-Path $WavDir "tts-medium.wav" },
    @{ name="long";   path=Join-Path $WavDir "tts-long.wav"  }
)

Write-Host "`n== ASR 基准 (SenseVoice, websocket-二进制PCM, CUDA) ==" -ForegroundColor Cyan
foreach ($w in $wavs) {
    if (-not (Test-Path $w.path)) { Write-Host "  [跳过] $($w.name)" -ForegroundColor Yellow; continue }
    $dur = Get-Duration $w.path
    $data = Read-Pcm $w.path
    Write-Host ""
    Write-Host "  [$($w.name)] ${dur}s, $($data.sr)Hz, $($data.pcm.Length) bytes" -ForegroundColor White
    for ($i = 1; $i -le 4; $i++) {
        $r = Send-WsPcm $data.pcm
        $ms = $r.ms; $txt = $r.text
        $rtf = if ($dur -gt 0) { [Math]::Round($ms / 1000 / $dur, 3) } else { 0 }
        $truncated = if ($txt.Length -gt 60) { $txt.Substring(0, 60) + "..." } else { $txt }
        $line = "    run$($i-1)   : ${ms}ms (RTF=$rtf) '$truncated'"
        if ($i -eq 1) {
            $line = "    warmup : ${ms}ms (RTF=$rtf) '$truncated'"
            Write-Host $line -ForegroundColor DarkGray
        } else {
            Write-Host $line -ForegroundColor Green
        }
    }
}

# ---------- 停止服务 ----------
Write-Host ""
Write-Host "== 停止服务 ==" -ForegroundColor Cyan
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force; Write-Host "  已停止 PID $($proc.Id)" }

Write-Host ""
Write-Host "== sherpa-onnx SenseVoice (websocket) 测试完成 ==" -ForegroundColor Yellow
