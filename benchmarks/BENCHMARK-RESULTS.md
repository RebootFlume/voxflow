# ASR/TTS 引擎基准测试报告（第一轮）

> 日期：2026-08-25
> 机器：i9-13900HX（24C/32T）+ RTX 4070 Laptop 8GB（驱动 591.74，CUDA 13.1）
> 测试音频：VITS-aishell3 合成的中文语音 3 条（2s / 8s / 20s），16bit WAV
> 完整数据：result-20260825-215546.csv

## 延迟结果（松键到出字的体感）

| 引擎 | 短句 2s | 中句 8s | 长句 20s |
|------|---------|---------|----------|
| **llama-Qwen3ASR (GGUF)** | **128ms · RTF 0.06** 🏆 | **320ms · RTF 0.04** | **660ms · RTF 0.03** |
| sherpa-SenseVoice (ONNX) | 2450ms · RTF 1.18 ⚠️ | 2906ms · RTF 0.35 | 5426ms · RTF 0.27 |
| sherpa-TTS VITS int8 (CPU?) | — | 38字合成 33s | — |

*每条预热1次+实测3次，取全部实测值；llama-server 参数：`-ngl 99 --ctx-size 8192 --parallel 1`*

## 准确率观察（同一批音频）

- **Qwen3-ASR**：自带标点。medium 句："语音输入法的核心指标是：手指延迟和实时率。"（"首字"误识为"手指"）
- **SenseVoice**：无标点。long 句错字较多（"推理服务→村里服务"、"跟随性→蹲随性"）
- 注意：测试音频为 TTS 合成，且 aishell3 词表不含 "llama/GGUF/sherpa" 等英文词（OOV 被跳过未发声），对两边都不完全公平。真人录音待测。

## 关键发现与坑

### 坑1：llama.cpp 默认上下文爆显存 → 慢500倍（已解决）

server 默认 ctx 自动扩到 41984 × 4 slots，KV cache 直接撑爆 8GB VRAM（测试机上魔兽世界还占着 ~3GB），
Windows WDDM 触发显存→内存回退，每次推理都在 PCIe 反复搬运：
- 默认参数：短句转写 **121 秒**
- 加 `--ctx-size 8192 --parallel 1` 后：**0.21 秒**（RTF 0.10）

**教训：llama-server 必须显式限制 ctx-size；桌面机 VRAM 有其他程序占用时要留余量。**

### 疑点1：sherpa SenseVoice 短句 RTF 1.18 异常（待查证）

两个可能原因：
1. **CLI 每次运行都重新加载模型**（~2.3s 固定开销计入延迟）——sherpa 有现成的
   `sherpa-onnx-offline-websocket-server.exe` 常驻模式可消除此成本
2. **CUDA 可能没生效**：sherpa CUDA 版需要 cuDNN 9 运行库，若缺失会静默回退 CPU。
   待验证：检查 bin 目录 cudnn DLL + verbose 日志中的 provider 信息

### 疑点2：VITS TTS 极慢（33s/38字，RTF≈3）

同样疑似 CPU 回退（日志显示 threads: 1）。输入法场景 TTS 不是关键路径，但后续需服务化+GPU。

## 初步结论

- **GGUF/llama-cpp 路线的速度优势被实测证实**：短句 128ms 是输入法理想水平，
  且 Qwen3-ASR 自带标点、支持热词上下文注入（prompt 里塞热词）
- **sherpa-onnx 还没发挥真实水平**：需补两组实验再下结论——
  ① websocket-server 常驻模式（消除进程启动+模型加载成本）
  ② 确认/启用 CUDA provider（cuDNN 9）
- llama.cpp 这条路已经跑通且有惊喜，之前担心的 FFI 工作量也省了（直接用官方 server 子进程）

## 下一步

1. [ ] sherpa 常驻服务模式重测（公平对比）
2. [ ] 排查 sherpa CUDA 是否生效（cuDNN 9）
3. [ ] 真人录音准确率对比
4. [ ] 选型决策 + VoxFlow 集成设计（子进程 + HTTP/stdio IPC）

--- 补充（2026-08-26 GPU 修复后重跑）---

修复内容：
- sherpa-onnx bin 目录原无任何 NVIDIA DLL（cuDNN/cuBLAS/cuFFT 全缺），已从 PyPI nvidia-cudnn-cu12 + nvidia-cufft-cu12 + llama-cpp cudart 包补齐
- 加 `--provider=cuda` 后 CUDA 提供者成功初始化（onnxruntime 不再报错）
- 重新运行 run-benchmark.ps1 -Backend cuda

修复后数据（已保存到 result-20260826-012449.csv）：
- sherpa-SenseVoice(ONNX, CUDA): short 4519ms(RTF 2.18) / medium 4867ms(RTF 0.60) / long 5558ms(RTF 0.28)
- sherpa-TTS(VITS, CUDA): 18283ms (包含模型加载初始化)
- llama-Qwen3ASR(GGUF, cuda): short 92ms(RTF 0.045) / medium 191ms(RTF 0.026) / long 411ms(RTF 0.021)

关键结论：
1. sherpa CLI 模式无论 CPU/GPU，每次运行都要重新加载模型 + 初始化 CUDA（固定 ~3-5s 开销），输入法场景完全不可用
2. sherpa 有现成的 websocket-server.exe 常驻服务，可消除启动开销（待后续测试）
3. llama-server 作为常驻 HTTP 服务，短句 92ms 是理想输入法延迟（RTF < 0.05 = 极跟手）
4. sherpa-onnx v1.13.6 原生支持 Qwen3-ASR 的 ONNX 版（OfflineQwen3ASRModelConfig），可作为 ONNX 路线备选
