# ASR/TTS 引擎验证实验（两条路线对比）

## 目的

用同一批测试音频，实测两条技术路线的延迟指标，为 VoxFlow 选型提供数据：

| 路线 | 引擎 | 模型 | 格式 |
|------|------|------|------|
| A | llama.cpp 官方预编译（mtmd 音频） | Qwen3-ASR-0.6B | GGUF |
| B | sherpa-onnx 官方预编译 | SenseVoice（识别）/ VITS aishell3（合成） | ONNX |

## 使用方法

```powershell
cd benchmarks

# 1. 下载全部依赖（约 1.5 GB，支持断点续传；默认 CUDA + 本地代理）
.\setup.ps1
#    变体：.\setup.ps1 -Backend cpu     （无显卡/不想装 CUDA 运行时）
#          .\setup.ps1 -Proxy ""       （直连不走代理）

# 2. 跑基准测试
.\run-benchmark.ps1
```

测试流程全自动：先用 VITS 合成 3 条不同长度的中文音频 → 两套引擎分别转写 → 输出 CSV 报告。

## 指标解读

- **Latency (ms)**：发出请求到拿到完整文本的耗时 ≈ 语音输入法「松键到出字」的体感
- **RTF**（实时因子）：处理耗时 ÷ 音频时长，`< 0.3` 有跟手感，越小越好
- 重点看 `short`（2 秒短句）那一行——这是输入法最常见场景
- 每条测 3 次（第一次是预热不计入）

## 目录结构（setup 后）

```
benchmarks/
├── llama-cpp/                    # 路线A
│   ├── llama-server.exe
│   ├── Qwen3-ASR-0.6B-Q8_0.gguf      (768 MB)
│   ├── mmproj-Qwen3-ASR-0.6B-Q8_0.gguf (205 MB, 音频编码器)
│   └── ...
├── sherpa-onnx/                  # 路线B
│   ├── sherpa-onnx-non-streaming-asr-x64-v1.13.6.exe   (SenseVoice CLI)
│   ├── sherpa-onnx-non-streaming-tts-x64-v1.13.6.exe   (VITS CLI)
│   ├── sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/
│   └── vits-zh-aishell3/
├── test-audio/                   # TTS 合成的测试音频
└── result-*.csv                  # 基准报告
```

## 已知注意事项

1. **llama.cpp 音频路径标记为 experimental**（官方 init 日志会提示 reduced quality）。
   如果转写质量明显不行，属于上游问题，不是我们配置错了——记录现象即可。
2. **本地回环必须绕过代理**：脚本里已加 `--noproxy "*"`，否则请求会被代理拦下。
3. **首次运行 llama-server 加载模型较慢**（几十秒），健康检查最长等 4 分钟。
4. CUDA 版需要 NVIDIA 驱动支持 CUDA 12.4+；报缺 DLL 就换 `-Backend cpu` 先跑通。
5. SenseVoice 是非自回归模型（一次前向出整句），理论上短句延迟显著低于
   Qwen3-ASR 的逐字生成——这正是本实验要验证的假设。

## 结果如何指导决策

| 实验结果 | 决策 |
|----------|------|
| SenseVoice 延迟达标且质量可接受 | 主力 = sherpa-onnx 一条管线（ASR+TTS），llama.cpp 砍掉 |
| Qwen3-ASR 明显更准且延迟可接受 | 双路线并存：llama-server 子进程 + sherpa-onnx 子进程 |
| 两者都不达标 | 再考虑引入更多模型变体（1.7B、bf16 等）重测 |
