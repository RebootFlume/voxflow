$ErrorActionPreference = "Stop"
$Root = "D:\app\ai\workspace\voxflow\benchmarks"
$BIN = Join-Path $Root "sherpa-onnx\sherpa-onnx-v1.13.6-cuda-12.x-cudnn-9.x-onnxruntime1.27.1-win-x64-cuda\bin\sherpa-onnx-offline-websocket-server.exe"
$MODEL = Join-Path $Root "sherpa-onnx\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17\model.int8.onnx"
$TOKENS = Join-Path $Root "sherpa-onnx\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17\tokens.txt"
$Port = 9002

Write-Host "Binary: $BIN"
Write-Host "Model: $MODEL"
Write-Host "Port: $Port"

if (-not (Test-Path $BIN)) { throw "Binary not found: $BIN" }
if (-not (Test-Path $MODEL)) { throw "Model not found: $MODEL" }

# Kill existing server
$existing = Get-Process -Name "sherpa-onnx-offline-websocket-server" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping existing server PID $($existing.Id)"
    Stop-Process -Id $existing.Id -Force
    Start-Sleep 2
}

Write-Host "Starting server..."
$proc = Start-Process -FilePath $BIN -ArgumentList "--sense-voice-model=$MODEL","--tokens=$TOKENS","--provider=cuda","--port=$Port" `
    -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Root "sherpa-ws.log") `
    -RedirectStandardError (Join-Path $Root "sherpa-ws.err")

Write-Host "Server PID: $($proc.Id), waiting 8s for model load..."
Start-Sleep 8

if ($proc.HasExited) {
    Write-Host "[ERROR] Server exited with code $($proc.ExitCode)" -ForegroundColor Red
    Write-Host "=== stderr ==="
    Get-Content (Join-Path $Root "sherpa-ws.err") | Select-Object -Last 20
    exit 1
}

# Check if port is listening
$tcpConn = Test-NetConnection -ComputerName "127.0.0.1" -Port $Port -WarningAction SilentlyContinue
if ($tcpConn.TcpTestSucceeded) {
    Write-Host "[OK] Server listening on port $Port" -ForegroundColor Green
} else {
    Write-Host "[WARN] Port $Port not responding yet" -ForegroundColor Yellow
}

Write-Host "=== stdout (last 10 lines) ==="
Get-Content (Join-Path $Root "sherpa-ws.log") | Select-Object -Last 10

Write-Host ""
Write-Host "=== Test: send test audio via WebSocket ==="
# Simple test using .NET WebSocket client
try {
    Add-Type -AssemblyName System.Net.WebSockets
    Add-Type -AssemblyName System.IO
    $wavPath = Join-Path $Root "test-audio\tts-short.wav"
    $wavBytes = [System.IO.File]::ReadAllBytes($wavPath)
    $wavBase64 = [Convert]::ToBase64String($wavBytes)

    $json = "{`"event`":`"message`",`"data`":{`"wavname`":`"test.wav`",`"wav`":`"$wavBase64`"}}"
    $body = [Text.Encoding]::UTF8.GetBytes($json)

    $uri = "ws://127.0.0.1:$Port/asr"
    Write-Host "Connecting to $uri..."
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $ct = [Threading.CancellationToken]::None
    $ws.ConnectAsync($uri, $ct).Wait(5000)
    Write-Host "Connected! Sending audio..."
    $ws.SendAsync([ArraySegment[byte]]$body, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait(10000)

    $buf = [byte[]]::new(4096)
    $result = $ws.ReceiveAsync([ArraySegment[byte]]$buf, $ct)
    if ($result.Wait(30000)) {
        $resp = [Text.Encoding]::UTF8.GetString($buf, 0, $result.Result.Count)
        Write-Host "Response: $resp" -ForegroundColor Cyan
    }
    $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "done", $ct).Wait(1000)
} catch {
    Write-Host "[WS ERROR] $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "Server still running: $(!$proc.HasExited), PID: $($proc.Id)"
Write-Host "Press Ctrl+C to stop, or run: Stop-Process -Id $($proc.Id) -Force"
