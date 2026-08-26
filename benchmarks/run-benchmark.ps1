# ============================================================
# VoxFlow ASR/TTS 引擎验证 —— 基准测试脚本
#
# 前置：先运行 .\setup.ps1
#
# 测试内容：
#   1. 用 sherpa-onnx TTS 合成 3 条不同长度的中文测试音频
#   2. llama-server (Qwen3-ASR) HTTP 转写 → 记录延迟
#   3. sherpa-onnx SenseVoice CLI 转写 → 记录延迟
#   4. 输出对比报告（延迟 / RTF）
#
# 指标说明：
#   Latency = 从发出请求到拿到完整文本的耗时（对输入法 = 松键到出字）
#   RTF     = 处理耗时 ÷ 音频时长（<0.3 有跟手感，越小越好）
# ============================================================
param(
    [int]$Port = 8931,
    [ValidateSet("cuda", "cpu")]
    [string]$Backend = "cuda",
    [string]$Proxy = "http://127.0.0.1:10808"
)

$ErrorActionPreference = "Continue"   # 原生 exe 会往 stderr 写日志，不能让 PS 当终止错误
$Root     = $PSScriptRoot
$LlamaDir  = Join-Path $Root "llama-cpp"
$SherpaDir = Join-Path $Root "sherpa-onnx"
$WavDir    = Join-Path $Root "test-audio"
$Report    = Join-Path $Root "result-$(Get-Date -Format 'yyyyMMdd-HHmmss').csv"

if (-not (Test-Path "$LlamaDir\Qwen3-ASR-0.6B-Q8_0.gguf")) { throw "缺少 llama.cpp 环境，请先运行 setup.ps1" }
New-Item -ItemType Directory -Force -Path $WavDir | Out-Null

# ---------- 工具函数 ----------
function Find-File($Dir, $Pattern, $Index = 0) {
    $hits = Get-ChildItem $Dir -Recurse -File -Filter $Pattern | Sort-Object FullName
    if ($hits.Count -le $Index) { return $null }
    return $hits[$Index].FullName
}

function Measure-Cmd {
    # 执行命令并返回 @{ ms = 耗时; output = stdout }（stderr 转字符串，不触发终止错误）
    param([scriptblock]$Cmd)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $out = & $Cmd 2>&1 | ForEach-Object { "$_" }
    $sw.Stop()
    return @{ ms = $sw.ElapsedMilliseconds; output = ($out -join "`n").Trim() }
}

$rows = New-Object System.Collections.Generic.List[object]

# ---------- 定位可执行文件与模型 ----------
$ttsExe    = Find-File $SherpaDir "sherpa-onnx-offline-tts.exe"
$asrExe    = Find-File $SherpaDir "sherpa-onnx-offline.exe"
$vitsDir   = Get-ChildItem $SherpaDir -Directory -Filter "vits-zh-aishell3" | Select-Object -First 1
$senseDir  = Get-ChildItem $SherpaDir -Directory -Filter "sherpa-onnx-sense-voice-*" | Select-Object -First 1
foreach ($x in @(@("ttsExe",$ttsExe), @("asrExe",$asrExe), @("vitsDir",$vitsDir), @("senseDir",$senseDir))) {
    if (-not $x[1]) { throw "找不到 $($x[0])，请检查 setup.ps1 是否完整执行" }
}

Write-Host "== 第 1 步：TTS 合成测试音频（3 条：短句/中句/长句）==" -ForegroundColor Cyan
$sentences = @(
    @{ name="short";  text="今天下午三点开会。" }
    @{ name="medium"; text="语音输入法的核心指标是首字延迟和实时率，松开按键的瞬间文字就要出现在屏幕上。" }
    @{ name="long";   text="我们计划把语音识别做成两条独立的技术路线，一条走原生 llama cpp 加载 GGUF 格式的模型，另一条走 sherpa onnx 加载 ONNX 格式的模型，两个推理服务各自独立运行，任何一个崩溃都不影响桌面应用的正常使用，同时还要保证足够低的延迟和良好的跟随性。" }
)
$wavs = @()
foreach ($s in $sentences) {
    $wavPath = Join-Path $WavDir "tts-$($s.name).wav"
    if (-not (Test-Path $wavPath)) {
        Write-Host "  合成 $($s.name): $($s.text.Substring(0,[Math]::Min(18,$s.text.Length)))..."
        & $ttsExe `
            "--provider=$Backend" `
            "--vits-model=$(Join-Path $vitsDir.FullName 'vits-aishell3.int8.onnx')" `
            "--vits-lexicon=$(Join-Path $vitsDir.FullName 'lexicon.txt')" `
            "--vits-tokens=$(Join-Path $vitsDir.FullName 'tokens.txt')" `
            "--tts-rule-fars=$(Join-Path $vitsDir.FullName 'rule.far')" `
            "--sid=16" `
            "--output-filename=$wavPath" `
            $s.text | Out-Null
    } else { Write-Host "  已存在 tts-$($s.name).wav" }
    if (-not (Test-Path $wavPath)) { throw "TTS 合成失败: $($s.name)" }

    # 读 wav 时长：从文件头解析采样率（aishell3 输出 8kHz，不能硬编码 16k）
    $bytes = [System.IO.File]::ReadAllBytes($wavPath)
    $sampleRate = [BitConverter]::ToUInt32($bytes, 24)
    $durSec = [Math]::Round(($bytes.Length - 44) / 2 / $sampleRate, 2)
    $wavs += @{ path = $wavPath; dur = $durSec; name = $s.name }
    Write-Host ("  -> {0} ({1}s)" -f (Split-Path $wavPath -Leaf), $durSec)
}
# 顺便记录 TTS 自身延迟（合成 medium 那条再跑一次计时）
$ttsTiming = Measure-Cmd { & $ttsExe `
        "--provider=$Backend" `
        "--vits-model=$(Join-Path $vitsDir.FullName 'vits-aishell3.int8.onnx')" `
    "--vits-lexicon=$(Join-Path $vitsDir.FullName 'lexicon.txt')" `
    "--vits-tokens=$(Join-Path $vitsDir.FullName 'tokens.txt')" `
    "--tts-rule-fars=$(Join-Path $vitsDir.FullName 'rule.far')" `
    "--sid=16" `
    "--output-filename=$(Join-Path $WavDir 'tts-timing-discard.wav')" `
    $sentences[1].text }
$rows.Add([pscustomobject]@{ Engine="sherpa-TTS(VITS)"; Audio="$($sentences[1].text.Length)字"; Run="avg-of-1"; Ms=$ttsTiming.ms; RTF="-" })
Write-Host ("  TTS 合成耗时: {0}ms" -f $ttsTiming.ms)

# ---------- 第 2 步：SenseVoice ASR ----------
Write-Host "`n== 第 2 步：sherpa-onnx SenseVoice (ONNX) ==" -ForegroundColor Cyan
$svModel  = Find-File $senseDir.FullName "*.int8.onnx"
$svTokens = Find-File $senseDir.FullName "tokens.txt"
foreach ($w in $wavs) {
    for ($i = 1; $i -le 4; $i++) {
        $r = Measure-Cmd { & $asrExe "--provider=$Backend" "--sense-voice-model=$svModel" "--tokens=$svTokens" $w.path }
        if ($i -eq 1) {
            $firstLine = ($r.output -split [char]10 | Where-Object { $_.Trim() } | Select-Object -Last 1)
            Write-Host "  [$($w.name)] 识别结果: $firstLine"
        }
        if ($i -gt 1) {  # 第一次是预热
            $rows.Add([pscustomobject]@{ Engine="sherpa-SenseVoice(ONNX)"; Audio="$($w.dur)s"; Run="run$($i-1)"; Ms=$r.ms; RTF=[Math]::Round($r.ms/1000/$w.dur,3) })
            Write-Host ("  [{0}] run{1}: {2}ms (RTF={3})" -f $w.name, ($i-1), $r.ms, [Math]::Round($r.ms/1000/$w.dur,3))
        } else {
            Write-Host ("  [{0}] warmup: {1}ms" -f $w.name, $r.ms)
        }
    }
}

# ---------- 第 3 步：llama-server Qwen3-ASR ----------
Write-Host "`n== 第 3 步：llama.cpp Qwen3-ASR (GGUF, mtmd 音频) ==" -ForegroundColor Cyan
$model  = Join-Path $LlamaDir "Qwen3-ASR-0.6B-Q8_0.gguf"
$mmproj = Join-Path $LlamaDir "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf"
$ngl = if ($Backend -eq "cuda") { 99 } else { 0 }
# 关键：默认 ctx 会自动扩到 41k×4 slots，8GB 显存直接撑爆触发 WDDM 内存回退，
# 推理慢 500 倍以上（实测 121s → 0.2s）。必须显式限制 ctx + 单 slot。
$serverArgs = @("-m", $model, "--mmproj", $mmproj, "--port", $Port, "-ngl", "$ngl", "--no-webui", "--ctx-size", "8192", "--parallel", "1")
Write-Host "  启动 llama-server: $($serverArgs -join ' ')"
$serverProc = Start-Process -FilePath (Join-Path $LlamaDir "llama-server.exe") `
    -ArgumentList $serverArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Root "llama-server.log") `
    -RedirectStandardError  (Join-Path $Root "llama-server.err.log")
try {
    Write-Host "  等待模型加载..."
    $ready = $false
    foreach ($i in 1..120) {
        Start-Sleep -Seconds 2
        try {
            $curlArgs = @("-s", "--max-time", "3", "http://127.0.0.1:$Port/health")
            if ($Proxy) { $curlArgs += @("-x", $Proxy) }
            $h = & curl.exe @curlArgs 2>$null
            if ($LASTEXITCODE -eq 0 -and $h -match 'ok') { $ready = $true; break }
        } catch {}
        if ($serverProc.HasExited) { throw "llama-server 进程退出，查看 llama-server.err.log" }
    }
    if (-not $ready) { throw "llama-server 健康检查超时（240s），查看日志" }
    Write-Host "  服务就绪"

    foreach ($w in $wavs) {
        for ($i = 1; $i -le 4; $i++) {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $curlArgs = @("-s", "--max-time", "300", "-X", "POST",
                "http://127.0.0.1:$Port/v1/audio/transcriptions",
                "-F", "file=@`"$($w.path)`"",
                "-F", "response_format=json")
            if ($Proxy) { $curlArgs += @("--noproxy", "*") }   # 本地回环不走代理！
            $resp = & curl.exe @curlArgs 2>&1 | Out-String
            $sw.Stop()
            $ms = $sw.ElapsedMilliseconds
            $rtf = [Math]::Round($ms/1000/$w.dur, 3)
            if ($i -eq 1) {
                $txt = "?"
                try { $j = $resp | ConvertFrom-Json; $txt = $j.text } catch {}
                Write-Host "  [$($w.name)] 识别结果: $txt"
                Write-Host "  [$($w.name)] warmup: ${ms}ms"
            } else {
                $rows.Add([pscustomobject]@{ Engine="llama-Qwen3ASR(GGUF)"; Audio="$($w.dur)s"; Run="run$($i-1)"; Ms=$ms; RTF=$rtf })
                Write-Host ("  [{0}] run{1}: {2}ms (RTF={3})" -f $w.name, ($i-1), $ms, $rtf)
            }
        }
    }
} finally {
    if ($serverProc -and -not $serverProc.HasExited) {
        Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "`n  llama-server 已停止"
    }
}

# ---------- 报告 ----------
Write-Host "`n========== 基准测试报告 ==========" -ForegroundColor Yellow
$rows | Format-Table -AutoSize
$rows | Export-Csv -Path $Report -NoTypeInformation -Encoding UTF8
Write-Host "已保存: $Report"
Write-Host ""
Write-Host "决策参考:"
Write-Host "  - 输入法场景关注 short 行的 Ms（= 松键到出字的体感）"
Write-Host "  - RTF < 0.3 即有跟手感；两条路线对比后选低者做主力"
