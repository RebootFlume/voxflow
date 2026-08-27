<div align="center">

# VoxFlow

**本地语音识别（ASR）+ 语音合成（TTS）桌面工具**

完全本地运行 · 隐私安全 · 多引擎架构 · 一键热键录音转文字

<img src="src-tauri/icons/128x128.png" width="96" height="96" alt="VoxFlow">

![Tauri](https://img.shields.io/badge/Tauri-2-24c8db?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-1.85-dea584?logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-x64-0078d6?logo=windows&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## ✨ 核心特性

- **🎙️ 全局热键录音转文字** — 按住热键说话，松手即识别，结果直接上屏
- **🔒 完全本地运行** — 音频数据不出设备，隐私安全
- **🧠 Qwen3-ASR 高性能识别** — llama.cpp GGUF 子进程推理，CUDA 加速
- **⚡ 多引擎架构** — llama-server / sherpa-onnx 双引擎，低端设备也能跑
- **🎵 多模型 TTS** — Kokoro / Matcha / ZipVoice 等 8+ 语音合成模型，按需加载
- **📼 音频文件批量转写** — WAV / MP3 / FLAC / OGG / M4A / WebM，长音频自动分段
- **📝 多格式导出** — TXT / SRT / VTT / JSON / LRC 字幕
- **🖥️ 显存监控** — 实时显示各推理框架 GPU 占用

## 🏗️ 架构

```
┌─────────────────────────────────────────────────┐
│                 VoxFlow 桌面应用                  │
│        Tauri 2 + React 19 + Rust（主进程）       │
├─────────────────────────────────────────────────┤
│  ASR 引擎注册表（registry）                      │
│  ├─ llama-server 子进程（GGUF · Qwen3-ASR）     │
│  │     └─ HTTP 推理 · CUDA/CPU · 高精度主引擎    │
│  └─ sherpa-onnx websocket server（ONNX）        │
│        └─ SenseVoice / Paraformer · 低端设备     │
│  TTS 引擎                                        │
│  └─ sherpa-onnx E2E（Kokoro/Matcha 等，按需加载）│
├─────────────────────────────────────────────────┤
│  音频：ffmpeg 子进程解码 · 重采样 · 麦克风采集     │
│  转写：60s 滑动窗口分段 · 进度事件 · 多格式导出   │
│  交互：全局热键 · 剪贴板上屏 · 显存轮询           │
└─────────────────────────────────────────────────┘
```

**设计原则**
- **崩溃隔离** — 推理框架全部跑在独立子进程，崩溃不影响主应用
- **横向扩展** — 新增引擎（如 PyTorch）只需实现 `AsrEngine` trait + 注册一行
- **模型状态域分离** — 下载状态（items[]）与加载状态（engines）完全独立

## 🚀 快速开始

### 环境要求

- Windows 10/11 x64（当前支持）
- [Git](https://git-scm.com/) + [Node.js 18+](https://nodejs.org/)
- [Rust 工具链](https://rustup.rs/)
- [FFmpeg](https://ffmpeg.org/download.html)（多格式音频解码，需加入 PATH）
- NVIDIA GPU + CUDA（可选，CPU 也可运行）

### 开发运行

```bash
git clone https://github.com/RebootFlume/voxflow.git
cd voxflow
npm install
npm run tauri dev
```

首次启动会进入「模型页」下载所需模型：

| 模型 | 用途 | 大小 | 备注 |
|---|---|---|---|
| Qwen3-ASR-0.6B | ASR 默认 | ~1GB | 快，内存占用低 |
| Qwen3-ASR-1.7B | ASR 高精度 | ~2.4GB | CPU 可跑但较慢 |
| SenseVoice-int8 | ASR 中文全能 | ~230MB | 中英日韩粤 5 语 |
| Paraformer-zh-small | ASR 超小 | ~74MB | 低端 CPU 首选 |
| Kokoro / Matcha 等 | TTS | 0.2-0.6GB | 按需加载 |

### 打包

```bash
npm run tauri build
```

## 🎮 使用指南

1. **启动** → Splash 自动加载上次模型（可跳过）
2. **录音转写** → 在「录音热键」页设置热键，按住说话，松手上屏
3. **文件转写** → 「音频转写」页选文件，选导出目录/格式，自动分段转写
4. **模型管理** → 「模型」页下载/加载/卸载/删除，切换推理设备（CPU/GPU）

## 📁 数据存储

```
%APPDATA%\com.voxflow.app\      # 安装模式
├── models\                     # 模型文件
├── logs\runtime.json           # 运行日志
└── history\YYYY-MM-DD.json     # 转写历史
```

> 便携模式：放在 exe 旁 `data\` 目录

## 🗺️ 路线图

- [x] Qwen3-ASR GGUF 识别（llama-server 子进程）
- [x] sherpa-onnx 双引擎（SenseVoice / Paraformer）
- [x] 长音频分批转写 + 进度
- [x] 多格式导出（TXT/SRT/VTT/JSON/LRC）
- [x] 启动 Splash + 阶段加载进度
- [ ] PyTorch 引擎接入（Qwen3-TTS 等）
- [ ] 模型自动下载（HF 镜像）
- [ ] macOS / Linux 支持

## 📜 致谢

- [CapsWriter-Offline](https://github.com/HaujetZhao/CapsWriter-Offline) — 分段转写算法参考
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — GGUF 推理
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) — ONNX 推理
- [Tauri](https://tauri.app/) — 桌面框架

## 📄 License

MIT
