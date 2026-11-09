# VoxFlow（Electron 版）

**本地语音识别（ASR）+ 语音合成（TTS）桌面工具** — Electron 移植版

完全本地运行 · 隐私安全 · 多引擎架构 · 一键热键录音转文字

> 本仓库是 Tauri 版的 **Electron 移植**。上游 Tauri 项目（`src-tauri/` + Rust 推理层）见
> [`RebootFlume/voxflow-tauri`](https://github.com/RebootFlume/voxflow-tauri)，作为**只读参考**，
> 本仓库不包含任何 Rust 代码。

---

## 🆚 与 Tauri 版的关系

| | Tauri 版（上游） | Electron 版（本仓库） |
|---|---|---|
| 框架 | Tauri 2 + Rust 主进程 | **Electron 45 + TypeScript 主进程** |
| 前端 | React 19 + Vite + Tailwind + shadcn/ui | **完全复用**（逐文件移植） |
| 推理引擎 | Rust 内嵌 + 子进程 | **进程内 FFI worker**（llama.cpp / sherpa-onnx / audio.cpp，各在独立子进程） |
| 内存占用 | ~30–50 MB | ~150 MB（自带 Chromium） |
| 打包体积 | 10–20 MB | ~150 MB（不含模型与推理框架） |
| 便携版形态 | 单文件 `portable.exe` | **zip 解压即用**（Electron 无法产出真单文件） |
| 用户数据 | `%APPDATA%\com.voxflow.app\` | **同一位置**（两版可共存、数据互通） |

### 移植范围

- ✅ **前端全量移植**：65 个源文件全部有对应物（63 个仅改 import 路径 `src/lib/tauri` → `src/lib/ipc`，`App.tsx` 逐字相同），`src/components/ui/*`（shadcn）13 个零改动
- ✅ **IPC 桥接**：`src/lib/ipc.ts` 顶替原 `src/lib/tauri.ts`，**导出函数名与签名保持不变**
- ✅ **主进程**：Tauri 的 45 个 `#[tauri::command]` 中 **44 个**已用 TypeScript 重写（仅缺 demo 用的 `greet`）；Electron 侧另加 1 个诊断命令 `get_instance_info`（单实例判定），共 **45 个**；前端实际调用的 36 个命令 **100% 已实现**
- ✅ **推理层**：llama.cpp / sherpa-onnx / audio.cpp 均走进程内 FFI worker（**独立子进程**，崩溃隔离不变）；不依赖 Python、不依赖 espeak-ng
- ✅ **原生能力**：全局热键、模拟粘贴、托盘、对话框、剪贴板 → Electron 内置 API

### 关键实现替换

| Rust 原实现 | Electron 版替代 |
|---|---|
| `tauri-plugin-global-shortcut` + `rdev` | `uiohook-napi`（原生 N-API 模块，含预编译二进制） |
| `enigo` 模拟 Ctrl+V | `uiohook.keyTap` → 回退 PowerShell `SendInput` |
| `arboard` 剪贴板 | `electron.clipboard` |
| `cpal` 麦克风采集 | 渲染进程 `getUserMedia` + `AudioContext`（主进程中继） |
| `tauri-plugin-dialog` | `electron.dialog.showOpenDialog` |
| `tiny_http` OpenAI 兼容 API | `node:http` |
| `reqwest` / `tungstenite` | `fetch` / `ws` |
| `hound` WAV 编解码 | 自实现 RIFF 解析器 |
| `windows-sys` `GetDiskFreeSpaceExW` | `fs.statfsSync` / PowerShell |
| `tauri::Emitter` 事件总线 | `webContents.send` + preload `contextBridge` |
| `data-tauri-drag-region` | CSS `-webkit-app-region: drag`（`.app-drag-region`） |

---

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────────┐
│                   VoxFlow 桌面应用                        │
│              Electron 45 + React 19 + TypeScript          │
├─────────────────────────────────────────────────────────┤
│  主进程（src/main）                                        │
│  ├── ipc/          45 个命令的 IPC 路由                    │
│  ├── inference/    ASR 引擎注册表 + llama-server + sherpa  │
│  ├── models/       模型清单 / 下载 / 运行时检测              │
│  ├── tts/          TTS 引擎 + 音色库                       │
│  ├── audio/        WAV 编解码 / ffmpeg / 重采样             │
│  ├── system/       热键 / 剪贴板 / 采集 / 对话框            │
│  └── tray.ts       系统托盘                                 │
├─────────────────────────────────────────────────────────┤
│  预加载（src/preload）  contextBridge 安全桥               │
├─────────────────────────────────────────────────────────┤
│  渲染进程（src/renderer）  React UI + Zustand             │
└─────────────────────────────────────────────────────────┘
              │ 子进程（崩溃隔离）
              ├── llama.cpp FFI worker    GGUF / Qwen3-ASR
              ├── sherpa-onnx FFI worker  ONNX / SenseVoice / TTS
              └── audio.cpp FFI worker     GGUF / MOSS-TTS 等多族
```

---

## 📁 目录结构

```
.
├── build/                    # 打包资源（图标、macOS entitlements）
├── resources/                # 运行时资源（托盘图标，不打包）
├── scripts/                  # 打包与发版脚本（PowerShell）
├── src/
│   ├── main/                 # Electron 主进程
│   │   ├── core/             # 数据根 / 事件总线 / 持久化 / 日志
│   │   ├── inference/        # ASR 引擎（注册表 / llama-server / 分段转写）
│   │   ├── models/           # 模型清单与下载
│   │   ├── audio/            # 音频解码
│   │   ├── system/           # 热键 / 剪贴板 / 采集 / 托盘交互
│   │   └── ipc/              # IPC 命令表（45 个命令）
│   ├── preload/              # contextBridge 桥
│   └── renderer/             # React 前端（与上游同源，仅改 import 路径）
├── electron.vite.config.ts   # electron-vite 构建配置
├── electron-builder.yml      # electron-builder 打包配置
└── scripts/rust-spec-to-ts.mjs  # 模型描述符表转换器（一次性工具）
```

---

## 🚀 快速开始

### 环境要求

- Windows 10/11 x64（当前主要支持平台）
- Node.js 20+ / npm 10+
- [FFmpeg](https://ffmpeg.org/download.html) 放入 PATH（多格式音频解码）
- NVIDIA GPU + CUDA（可选，CPU 也可运行）
- 编译原生模块需 Visual Studio Build Tools（`uiohook-napi` 已带预编译二进制，通常无需编译）

```bash
npm install     # 安装依赖（postinstall 自动 rebuild 原生模块）
npm run dev     # 开发模式（主进程 / 预加载 / 渲染进程 HMR）
npm run build   # 类型检查 + 构建到 out/
npm start       # 预览构建产物
```

### 打包

```bash
npm run build:win      # NSIS 安装包
npm run bundle         # 安装版 + 便携版 zip（产物在 dist-bundle/）
npm run version:sync   # 版本号同步（事实源 = package.json）
npm run release        # 一键发版（打包 + git push + gh release）
```

---

## 🔌 IPC 命令表

命令名与 Tauri 版**完全一致**，前端调用形状不变：

```ts
// 渲染进程
const text = await window.voxflow.invoke<string>('rust_transcribe_llama', {
  filePath: '/path/to/audio.wav'
})
```

事件通道同样保持两个：

- `sidecar://event` —— 主总线，payload 用 `status` 字段判别（约 39 个取值）
- `asr://status` —— 热键录音状态（`idle` / `recording` / `recognizing`）

---

## 📊 数据存储

与 Tauri 版**完全兼容同一数据根**：

```
%APPDATA%\com.voxflow.app\      # 安装模式
├── models\                     # 模型文件
├── config.json                 # 配置
├── history\                    # 转写历史
└── logs\                       # 运行日志
```

> 便携模式：exe 旁存在 `portable.txt` 时，数据根 = `<exe>\data\`

### 模型目录按框架分层

`models\` 下按**推理框架**分层，同名模型（如图音色的 Qwen3-ASR-0.6B）分属不同层，互不冲突：

```
models\llama.cpp\{qwen3-asr-0.6b, qwen3-asr-1.7b}\
models\sherpa-onnx\{sense-voice-int8, paraformer-zh-small, kokoro-multi-lang-v1_0, ...}\
models\audio.cpp\{qwen3-asr-0.6b, fun-asr-nano, moss-tts-nano-100m, ...}\
models\hub\   # HuggingFace 下载缓存
```

- 模型的**复合身份** = `<框架层>/<目录名>`（如 `llama.cpp/qwen3-asr-0.6b`）：config 里的模型键、IPC 参数、事件里的 model 字段都用它。
- 界面展示名可跨层重复，靠框架分组区分。
- 旧版扁平目录（`models\qwen3-asr-0.6b-gguf\` 等）会在启动时自动迁移到分层目录。

---

## 🗺️ 移植进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| 一 | 前端移植 + IPC 桥 + 窗口/托盘/热键/剪贴板/持久化 + ASR 主链路 | ✅ **完成并验证** |
| 二 | TTS 引擎 + 音色库 + 克隆音色 | ✅ **完成并验证**（Kokoro 真实合成通过） |
| 三-a | 模型下载 / 删除 / 磁盘占用（`model_manager`） | ✅ 已实现（未做真实下载验证） |
| 三-b | 推理框架运行时下载（llama / sherpa 包） | ✅ **完成并验证**（真实下载 + 解压 + 落位 + 试启动通过） |
| 三-d | OpenAI 兼容对外 API 服务 | ✅ **完成并验证**（16 项契约测试 + 真实模型转写通过） |
| 三-e | sherpa-onnx ASR 引擎（SenseVoice / Paraformer） | ✅ **完成并验证**（真实模型转写通过） |
| 三-f | audio.cpp TTS 引擎（MOSS-TTS-Nano 等 GGUF 族） | ✅ **完成并验证**（真实模型合成通过，48kHz） |
| 四 | 打包与发版流程 | ✅ 脚本就绪，`build:unpack` 已验证 |

前端调用的命令已 100% 实现；调用未注册的命令会抛出「未知命令: xxx」，不会静默失败。

### 已验证项

| 项 | 结果 |
|---|---|
| `npm run typecheck` | node + web 双端 0 错误 |
| `npm run build` | 通过（main / preload / renderer 三份产物） |
| 开发态启动 | 无 stderr 报错，UI 正常渲染 |
| 打包态启动 | 从 `app.asar` 渲染正常，`extraResources` 落位正确 |
| IPC 桥 | 45 个命令路由通；未知命令正确报错 |
| 事件总线 | `models_state` 载荷与 Tauri 版**逐字段一致**（14 个模型 / 磁盘余量 / 各框架能力字段） |
| 数据根 | `%APPDATA%\com.voxflow.app\` —— **与 Tauri 版同一目录**，config.json / logs 直接互通 |
| 显存监控 | nvidia-smi 真值：RTX 4070 Laptop，1.7 / 8.0 GB (21%) |
| 原生模块 | `uiohook-napi` 经 electron-builder rebuild 后正确解包（`asarUnpack: **/*.node`） |
| TTS 单元测试 | `npm run test:tts` —— 48 项全过（切分 / 音色库 / argv 解释器 / 时长钳制） |
| TTS 端到端 | `npm run verify:tts` —— 24 项全过（音色库全流程 / 错误分支 / 索引格式） |
| TTS 索引格式 | `voices.json` 用 snake_case，与 Tauri 版共用同一份文件可直接互换 |
| 运行时下载 | `npm run verify:runtime` —— 16 项全过；**真实下载 llama-cpp b12211（289MB）→ 解压 → 落位 → 试启动 → state:ready** |
| 代理链路 | 系统代理（HTTP_PROXY）自动接管，HTTP CONNECT 隧道可用 |
| 对外 API | `npm run verify:api` —— 16 项全过（鉴权 / 路由 / 错误码 / multipart / WAV 编码） |
| **真实推理闭环** | `npm run verify:real` —— **25 项全过**：Kokoro TTS 合成 → Qwen3-ASR(CUDA) 转写 → SenseVoice 转写 → 对外 API 转写，识别文本与原文一致 |
| audio.cpp 端到端 | 真机：`MOSS-TTS-Nano`（q8_0，193MB，CPU）加载 + 中英合成通过，wav 48kHz / 峰值 27592（非静音） |
| audio.cpp 运行时与 ASR | 单一全功能包（官方 CUDA 变体 zip，自带全套 `ggml-cpu-*.dll`）：CPU / CUDA 两设备共用同一份，切设备只换后端名；`Qwen3-ASR-0.6B/1.7B`、`Fun-ASR-Nano`、`MOSS-Transcribe-Diarize` 真机转写通过（MOSS 带说话人分离与时间戳） |
| audio.cpp TTS 音色 | `Qwen3-TTS-1.7B (CustomVoice)` 9 个预设音色（vivian/serena/uncle_fu/dylan/eric/ryan/aiden/ono_anna/sohee）真机合成通过，24kHz，峰值 18182 / 22500（非静音） |
| audio.cpp 音色描述 | `Qwen3-TTS-1.7B (CustomVoice)` 的 `instruct`（一句话描述嗓音/风格）：同 seed 下无/低沉/高亢三组输出时长与能量分布明显不同，证明描述生效；不支持该能力的模型（MOSS-TTS-Nano）明确拒绝 |
| audio.cpp 克隆音色 | `Qwen3-TTS-0.6B (Base)` / `1.7B (Base)`（仅克隆，`voice_mode.type = clone`）：参考音频 5.6s + 参考文本 → `audiocpp_request_set_voice_audio` 下发 → 合成 24kHz 非静音，SenseVoice 回读文本一致 |
| 音色选择全链路 | 预设（9 音色下拉，合成页可就地切换）/ 克隆（音色库「使用」→ 自动恢复）/ 音色描述（输入即下发，试听前 flush）。`voice` 同时接受序号与音色名（含 `alloy (EN)` 这类后缀），认不出时记 warn 并退默认音色，越界序号直接报可用范围 |
| 音色页对称禁用 | 仅克隆模型禁用「预设音色」页并自动切到克隆工作区；仅预设模型禁用「克隆音色」页；换模型时引擎丢弃上一份参考音频（否则预设模型被当克隆请求，报 `prefill requires speaker`） |
| 无 Python / 无 eSpeak | 运行时只剩 `llama-cpp` / `sherpa-onnx` / `audio-cpp`，三者均 Apache-2.0；TTS 音素化由模型自带 lexicon 完成 |

### 真实推理验证（最有说服力的一条）

用上游便携版已有的**真模型 + 真推理框架**跑完整链路：

```
Kokoro TTS (sherpa-onnx)   合成 "今天下午三点开会"
                          → 24000Hz / 2.18s / peak=9808（真实音频，非静音）
Qwen3-ASR-0.6B (llama-server + CUDA 1.1GB 权重)  → "今天下午三点开会。"
SenseVoice    (sherpa-onnx websocket server)      → "今天下午三点开会"
OpenAI 兼容对外 API (POST /v1/audio/transcriptions) → "今天下午三点开会"
```

三条独立推理链路 + 一条对外接口，识别文本与原文**完全一致** —— 证明移植与 Tauri 版行为等价。
**开发态与打包态（从 `app.asar` 运行）各跑一遍，均 25/25 通过。**

> 依赖：本机需已装 `llama-cpp` / `sherpa-onnx` 运行时（在 exe 旁 `libs/`），
> 并已下载对应模型（模型根由 `config.json` 的 `models.modelRoot` 决定，
> 默认是 `<数据根>/models`）。

### 验证脚本

```bash
# 启动应用（开 CDP 端口）
electron out/main/index.js --remote-debugging-port=9222
npm run verify:renderer   # UI 渲染 + IPC 冒烟
npm run verify:events     # 事件总线载荷校验
npm run verify:tts        # TTS 命令端到端校验
npm run verify:runtime    # 推理框架运行时下载端到端校验
npm run verify:api        # OpenAI 兼容 API 契约校验
npm run verify:real       # 真实推理闭环（需要已装运行时与已下载模型）
npm run test:tts          # TTS 单元测试（纯逻辑，无需运行时）
npm run screenshot        # 截图到 %TEMP%

npm run install:runtime 9222 gguf   # 真实安装运行时（数百 MB，人工验证用）

npm run check:updates     # 查三个推理框架的官方最新版本（只报告，不下载）
npm run check:abi         # 校验 koffi 绑定与官方头文件的结构体字段是否一致
```

> 升级推理框架（llama.cpp / sherpa-onnx / audio.cpp）前先读 [docs/upgrade-runtime.md](docs/upgrade-runtime.md)：
> 三个框架都把 C ABI 手工复述成 koffi 绑定，头文件结构体一变，绑定层不会报错、只会静默读错位，
> 所以升级流程里 `npm run check:abi` 是必做步骤。

### 已知偏差（与 Tauri 版）

| 项 | Tauri 版 | Electron 版 | 原因 |
|---|---|---|---|
| 代理环境变量 | 删掉（reqwest 隐式读 env） | **保留** | Node 的 fetch 不隐式读 env，删掉只会影响本进程拉起的子进程 |
| 运行时试启动超时 | 6s | 15s | 冷缓存下要加载 ~550MB CUDA DLL 才 listen，6s 会误报「DLL 缺失」 |
| 便携版形态 | 单文件 `portable.exe` | zip 解压即用 | Electron 无法产出真单文件（自解压需每次解 150MB Chromium） |
| 多实例 | 可同时开多个 | **全局单实例**：第二实例唤起主窗口后退出（控制端口 8930；调试可用 `VOXFLOW_ALLOW_MULTI=1` 绕过） | 冲突根源是全局资源而非配置文件：全局热键、固定端口（8931 / 9002）、显存。双开会互相覆盖 `config.json`、双触发热键、甚至互杀对方的引擎进程 |
| 麦克风设备名 | cpal 直接给真实名 | 需先真正打开过一次麦克风才有真名（启动时自动探测并回填），未授权时显示「麦克风 N」 | 浏览器规范要求未授权时 `deviceInfo.label` 为空 |
| 麦克风选择 | 可指定设备 | 暂用系统默认（未做选择器 UI） | 渲染进程已透传真实 deviceId 到 `getUserMedia`，仅缺 UI |
| 录音重采样 | cpal 原生采 16kHz | 线性插值重采样 | Web Audio 的采集采样率不保证是 16k |
| 录音音量 | 不推 volume 事件 | 不推 volume 事件 | 上游缺口，两版一致（音量条恒为 0） |
| 显存轮询 | 每 10s | 每 15s；窗口隐藏时停摆、重新可见立即补一次 | Electron 主进程每轮会拉外部进程（nvidia-smi / WMI），降频以避免点击卡顿 |

---

## 📄 License

MIT
