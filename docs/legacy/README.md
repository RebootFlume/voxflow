# VoxFlow — 本地 Qwen3-ASR 语音工具（开发规格书）

> 本文档是项目的唯一开发依据。所有功能点、技术要点、接口协议均已写入，AI / 开发者照本文档逐项实现即可。

---

## 1. 项目概述

**定位**：一款常驻后台的本地语音输入工具。按住快捷键说话，松开自动识别并把文字"打"进当前光标所在输入框；同时内置一个可选的 OpenAI 兼容 ASR/TTS 服务，供其他软件（Chatbox、Cherry Studio、Obsidian 等）调用。

**产品形态**：Windows 桌面应用，系统托盘常驻 + 悬浮状态条 + 设置主窗口（VS Code 风格三栏）。

**核心体验**：按住即录、松开上屏、极低延迟、本地推理（不联网、不传云端）。

---

## 2. 技术栈（已确定，勿改）

| 层 | 技术 | 说明 |
|---|---|---|
| 前端框架 | React 19 + Vite 7 + TypeScript | 已就绪 |
| 样式 | Tailwind CSS 3.4 + PostCSS + Autoprefixer | 已就绪 |
| 组件库 | shadcn/ui（Radix 封装） | 已配置 `components.json`，`@` 别名可用 |
| 图标 | lucide-react | 已安装 |
| 类名工具 | clsx + tailwind-merge（`src/lib/utils.ts` 的 `cn()`） | 已就绪 |
| 状态管理 | Zustand | 已安装 |
| 桌面壳 | Tauri v2（Rust 主进程） | 已初始化，端口 1420 |
| AI 推理后端 | Python Sidecar（`qwen-asr` 官方包 + FastAPI） | 待创建 `python-backend/` |

前端依赖已全部安装，无需重复安装。新增组件用：`npx shadcn@latest add <组件名>`。

---

## 3. 总体架构

```
┌────────────────────────── VoxFlow (Tauri v2) ──────────────────────────┐
│  ┌─────────────────┐        ┌──────────────────────────────────────┐  │
│  │ React 前端三栏    │ invoke │ Rust 主进程                          │  │
│  │ (设置主窗口)      │◄──────►│ - 全局热键监听（长按/组合键）          │  │
│  │ (悬浮状态条)      │        │ - 托盘图标 / 菜单                     │  │
│  └─────────────────┘        │ - 剪贴板写入 + 模拟 Ctrl+V 上屏        │  │
│                             │ - Sidecar 进程生命周期管理             │  │
│                             └──────────────┬───────────────────────┘  │
└────────────────────────────────────────────┼──────────────────────────┘
                                              │ ① 控制指令：stdin/stdout JSON
                                              │ ② 音频流：本地 WebSocket（二进制）
                                              ▼
                              ┌──────────────────────────────────────┐
                              │ Python Sidecar（模型常驻内存）         │
                              │ - Qwen3-ASR 推理（transformers/vLLM）  │
                              │ - sounddevice 麦克风采集（16kHz）      │
                              │ - Silero VAD 静音过滤                  │
                              │ - FastAPI（按需启停，默认 127.0.0.1:9870）│
                              └──────────────┬───────────────────────┘
                                             │ ③ 对外 HTTP（默认关闭，点击才开）
                                             ▼
                              ┌──────────────────────────────────────┐
                              │ 第三方客户端                          │
                              │ POST /v1/audio/transcriptions (ASR)  │
                              │ POST /v1/audio/speech        (TTS)   │
                              └──────────────────────────────────────┘
```

**职责划分**：
- **Rust 主进程**：只管系统级操作（热键、托盘、剪贴板、模拟按键、Sidecar 启停）。不做 AI 推理，不直接对外开 HTTP。
- **Python Sidecar**：管所有语音/AI 事务（录音、VAD、推理、API 服务）。模型常驻内存，API 服务子线程动态启停（启停不重载模型）。

---

## 4. 功能总清单

优先级：**P0 = 首版必须**，P1 = 第二版，P2 = 远期。

### 4.1 P0（首版必须）

| # | 模块 | 功能点 | 说明 |
|---|---|---|---|
| 1 | ASR | 全局热键长按录音 | 默认长按 `CapsLock`：按下开始录音，松开触发识别；支持自定义（如 `Alt+Space`） |
| 2 | ASR | 麦克风采集 | `sounddevice` 16kHz 单声道，自动选择默认输入设备 |
| 3 | ASR | VAD 静音过滤 | Silero VAD，自动截取有效语音片段，过滤静音 |
| 4 | ASR | 本地推理 | Qwen3-ASR-0.6B（默认）或 1.7B，支持 CPU / CUDA 切换 |
| 5 | ASR | 极速上屏 | 识别文本 → 写入剪贴板 → 模拟 `Ctrl+V` 粘贴到当前输入框 |
| 6 | ASR | 状态反馈 | 托盘图标 + 悬浮条：空闲/录音中/识别中/成功/失败，实时音量波形 |
| 7 | 后端 | 模型加载状态 | 前端显示 加载中/就绪/失败，推理设备（CPU/CUDA） |
| 8 | 后端 | IPC 通信 | 控制走 stdin/stdout JSON；音频流走本地 WebSocket |
| 9 | API | OpenAI 兼容 ASR 接口 | `POST /v1/audio/transcriptions`，返回 `{"text": ...}` |
| 10 | API | 动态启停 | 默认关闭；前端开关控制，端口可配置（默认 9870） |
| 11 | API | API Key 鉴权 | 可选，启用后要求 `Authorization: Bearer <key>` |
| 12 | API | 端点状态指示 | 面板显示两个端点（ASR/TTS）的在线状态灯 |
| 13 | GUI | 三栏设置界面 | ActivityBar + Sidebar + Main（规格见 §5） |
| 14 | GUI | 配置持久化 | 热键、设备、端口、Key 等设置本地保存，重启保留 |
| 15 | 系统 | 系统托盘 | 托盘图标，菜单：显示主窗口 / 退出 |
| 16 | 系统 | 悬浮条 | 极简小窗，录音/识别状态 + 音量波形，可关闭 |

### 4.2 P1（第二版）

| # | 模块 | 功能点 | 说明 |
|---|---|---|---|
| 17 | TTS | 音色选择 | 下拉框选择音色 |
| 18 | TTS | 语速/音量调节 | 滑块调节 |
| 19 | TTS | 划词朗读快捷键 | 选中文本后按快捷键朗读 |
| 20 | TTS | 试听 | 文本框 + "试听"按钮，验证合成效果 |
| 21 | TTS | OpenAI 兼容 TTS 接口 | `POST /v1/audio/speech`，返回音频二进制 |
| 22 | 历史 | 历史日志 | 本地存储（SQLite/JSON）历史识别记录 |
| 23 | 历史 | 搜索/复制/删除 | 历史记录列表操作 |
| 24 | 热词 | 热词纠错 | 自定义词库/替换规则 |
| 25 | 音频 | 格式兼容 | `pydub/ffmpeg` 将 wav/mp3/m4a/ogg/webm 统一转码为 16kHz wav |

### 4.3 P2（远期）

| # | 模块 | 功能点 |
|---|---|---|
| 26 | ASR | 流式上屏：WebSocket `/ws/live-asr`，边说边出字 |
| 27 | 多模型 | SenseVoice / Whisper 切换 |
| 28 | 系统 | 自动更新（Tauri updater） |
| 29 | 系统 | 开机自启 |
| 30 | i18n | 多语言界面 |

---

## 5. 界面布局规格（VS Code 风格三栏）

### 5.1 布局结构

```
┌────────┬────────────┬──────────────────────────────────┐
│ 48px   │ 200px      │ flex-1                           │
│Activity│ Sidebar    │ Main Content                     │
│  Bar   │ (二级菜单)  │ (配置表单/开关/滑块/测试控制台)    │
├────────┴────────────┴──────────────────────────────────┤
│ 悬浮状态条（独立小窗，全局置顶，可移动）                  │
└─────────────────────────────────────────────────────────┘
```

### 5.2 Activity Bar（最左侧，宽 48px）

- **顶部**（自上而下）：🎙️ 语音识别(ASR)、🔊 语音合成(TTS)、🌐 API 服务、📜 历史日志
- **底部**：⚙️ 系统设置
- 交互：点击切换当前激活模块，选中项高亮；图标用 lucide-react（`Mic` / `Volume2` / `Globe` / `History` / `Settings`）

### 5.3 Sidebar（中间，宽 200px）

根据 Activity Bar 选中模块显示对应二级菜单项：

| 模块 | 二级菜单项 |
|---|---|
| ASR | 录音热键、模型与设备、状态监控 |
| TTS | 音色设置、语速音量、划词朗读、试听 |
| API | 服务开关、端口与 Key、端点状态、测试控制台 |
| 历史 | 记录列表（含搜索） |
| 设置 | 通用（悬浮条开关、开机自启、关于） |

### 5.4 Main Content（右侧，flex-1）

展示当前二级菜单对应的具体表单/控件：
- **ASR**：热键输入框（支持按键录制）、模型下拉（0.6B/1.7B）、设备切换（CPU/CUDA）、模型加载状态徽标、音量波形条
- **TTS**：音色下拉、语速滑块、音量滑块、划词朗读快捷键、文本框 + 试听按钮
- **API**：总开关（Switch）、端口输入（默认 9870）、API Key 输入、两个端点状态灯（ASR/TTS）、测试控制台（curl 示例一键复制）
- **历史**：记录列表 + 搜索框 + 复制/删除按钮
- **设置**：悬浮条显示开关、关于信息（版本号）

**可复用组件**（用 shadcn）：`Button / Card / Input / Slider / Switch / Select / Textarea / Badge / ScrollArea / Tabs`。

---

## 6. 状态管理（Zustand，`src/stores/app.ts`）

```ts
type Module = 'asr' | 'tts' | 'api' | 'history' | 'settings'

interface AppState {
  activeModule: Module              // 当前激活模块
  activeSubMenu: string             // 当前二级菜单项

  // ASR
  asr: {
    hotkey: string                  // 如 'CapsLock' / 'Alt+Space'
    model: 'Qwen3-ASR-0.6B' | 'Qwen3-ASR-1.7B'
    device: 'cpu' | 'cuda'
    modelStatus: 'idle' | 'loading' | 'ready' | 'error'
    status: 'idle' | 'recording' | 'recognizing' | 'done' | 'error'
    volume: number                  // 实时音量 0-1（用于波形）
  }

  // TTS
  tts: {
    voice: string
    rate: number                    // 0.5 - 2.0
    volume: number                  // 0 - 1
    hotkey: string
  }

  // API 服务
  api: {
    enabled: boolean
    port: number                    // 默认 9870
    apiKey: string
    endpoints: { asr: boolean; tts: boolean }  // 状态灯
  }

  // Actions
  setActiveModule: (m: Module) => void
  setActiveSubMenu: (s: string) => void
  updateAsr: (patch: Partial<AppState['asr']>) => void
  updateTts: (patch: Partial<AppState['tts']>) => void
  updateApi: (patch: Partial<AppState['api']>) => void
  toggleApi: (on: boolean) => void   // 调用后端启动/停止 API
}
```

持久化：热键/设备/端口/Key 等用户设置用 `persist` 中间件写入 localStorage（或 Tauri store 插件）。

---

## 7. 后端服务规格（Python Sidecar）

### 7.1 进程职责

- 随应用启动拉起、随应用退出关闭（由 Rust 管理生命周期）
- 启动即加载模型（耗时数秒~数十秒），加载期间前端显示"加载中"
- 模型常驻内存；API 服务由指令动态启停，**不重启进程、不重载模型**

### 7.2 IPC 协议（Rust ↔ Python）

**① 控制通道：stdin/stdout，一行一个 JSON**

```jsonc
// Rust → Python（stdin）
{ "action": "start_recording" }
{ "action": "stop_recording" }                       // 触发识别
{ "action": "set_model", "model": "Qwen3-ASR-0.6B", "device": "cuda" }
{ "action": "start_api", "host": "127.0.0.1", "port": 9870, "api_key": "" }
{ "action": "stop_api" }

// Python → Rust（stdout）
{ "status": "model_loading" }
{ "status": "model_ready", "device": "cuda" }
{ "status": "recording_started" }
{ "status": "recognized", "text": "识别结果文本" }
{ "status": "api_started", "port": 9870 }
{ "status": "api_stopped" }
{ "status": "error", "msg": "错误描述" }
```

**② 音频通道：本地 WebSocket（`ws://127.0.0.1:<port>/ws/live-asr`）**
- 上行：16kHz 单声道 PCM 二进制音频块（录音期间持续推流）
- 下行：识别结果文本增量（P0 可只做整段返回）

### 7.3 对外 HTTP API（FastAPI，按需启动）

**ASR — `POST /v1/audio/transcriptions`**（OpenAI 兼容）
```http
Content-Type: multipart/form-data
Authorization: Bearer <api_key>        # 仅当启用 Key 时要求

file=<音频>   model=qwen3-asr   language=zh   response_format=json
```
```json
{ "text": "识别出的文本" }
```

**TTS — `POST /v1/audio/speech`**（P1）
```json
{ "model": "qwen-tts", "input": "要朗读的文本", "voice": "default" }
```
响应：音频二进制流（`audio/mpeg` 或 `audio/wav`）。

**鉴权**：`api_key` 非空时校验 `Authorization: Bearer`，不匹配返回 401。
**并发**：推理入口加锁串行，防止显存 OOM。

### 7.4 模型推理要点（Qwen3-ASR）

- 官方包：`pip install qwen-asr`（阿里 Qwen Team 发布，v0.0.6）
- 官方用法（勿自造 API）：
  ```python
  from qwen_asr import Qwen3ASRModel
  model = Qwen3ASRModel.from_pretrained(
      "Qwen/Qwen3-ASR-0.6B",        # 或 1.7B
      dtype=torch.bfloat16,
      device_map="cuda:0",          # 或 "cpu"
      max_inference_batch_size=4,   # 防 OOM
      max_new_tokens=256,
  )
  results = model.transcribe(audio=audio_bytes, language=None)
  text = results[0].text            # 自动语言检测，也可强制 language="Chinese"
  ```
- 支持 `pip install -U qwen-asr[vllm]` 用 vLLM 后端提速；支持流式推理（P2 用）
- 依赖锁定：官方要求 `transformers==4.57.6`、`accelerate==1.12.0` 等精确版本，**requirements.txt 必须照官方锁版本**，避免与推理环境冲突
- 音频输入支持：本地路径 / URL / base64 / `(np.ndarray, sr)` 元组

---

## 8. 系统集成要点（Rust 主进程）

### 8.1 全局热键

- **组合键**（Alt+Space 等）：用 Tauri 官方插件 `tauri-plugin-global-shortcut`（官方插件仓库名为 `global-shortcut`，**不是** global-hotkey）
- **长按 CapsLock 按下/松开**：官方插件不支持"按下/松开"语义，需用低层全局键盘钩子（如 `rdev` crate）监听 `KeyDown/KeyUp`

### 8.2 文本上屏

- 剪贴板写入：`arboard` crate（只负责剪贴板）
- 模拟按键：`enigo` crate（只负责模拟 `Ctrl+V`，**enigo 不操作剪贴板**，必须两库配合）

### 8.3 Sidecar 配置（打包时）

`tauri.conf.json`：
```json
"bundle": {
  "externalBin": ["binaries/qwen-asr-engine"]
}
```
- **二进制文件命名必须带 target 三元组后缀**：
  `src-tauri/binaries/qwen-asr-engine-x86_64-pc-windows-msvc.exe`
- Rust 侧：`Command::sidecar("qwen-asr-engine")?.spawn()`

### 8.4 托盘

- 用 Tauri `tray-icon`：图标 + 菜单（显示主窗口 / 退出）
- 悬浮条：独立无边框透明窗口，`always_on_top`，可拖动

---

## 9. 项目结构（目标形态）

```
voxflow/
├── src/                          # React 前端
│   ├── components/ui/            # shadcn 生成组件
│   ├── components/               # 业务组件（ActivityBar/Sidebar/Main/StatusBar）
│   ├── stores/app.ts             # Zustand（§6）
│   ├── modules/                  # 各模块面板：asr/ tts/ api/ history/ settings
│   ├── lib/utils.ts              # cn() 已就绪
│   ├── App.tsx                   # 三栏布局组装
│   ├── main.tsx                  # 已引入 index.css
│   └── index.css                 # Tailwind + shadcn 变量
├── src-tauri/
│   ├── src/                      # Rust：main.rs / lib.rs + hotkey / tray / clipboard / sidecar 模块
│   ├── binaries/                 # PyInstaller 产物（带 target 后缀命名）
│   └── tauri.conf.json           # externalBin 等
├── python-backend/               # Python Sidecar（待创建）
│   ├── app.py                    # 入口：加载模型 + stdin 监听 + FastAPI
│   ├── asr_engine.py             # Qwen3ASRModel 封装（§7.4）
│   ├── vad.py                    # Silero VAD 封装
│   ├── api_server.py             # FastAPI 路由（§7.3）
│   ├── requirements.txt          # 按官方锁版本
│   └── build.py / qwen-asr-engine.spec  # PyInstaller 打包脚本
├── components.json               # shadcn 配置
├── tailwind.config.js / postcss.config.js
└── vite.config.ts / tsconfig.json   # 已配置 @ 别名
```

---

## 10. 开发待办清单（按序执行）

### 阶段 1：前端骨架（先做，可脱离后端 mock）
- [ ] 引入 shadcn 基础组件：`npx shadcn@latest add button card input slider switch select textarea badge scroll-area tabs separator`
- [ ] 实现 `src/stores/app.ts`（§6 全部字段与 action）
- [ ] 实现 ActivityBar（48px，顶部 4 图标 + 底部设置，选中高亮）
- [ ] 实现 Sidebar（200px，按模块渲染二级菜单）
- [ ] 实现 Main Content 五个模块面板骨架（先用假数据）
- [ ] 实现悬浮状态条组件（独立窗口：状态文字 + 音量波形）
- [ ] App.tsx 组装三栏布局
- [ ] 验收：`npm run dev` 下切换图标，三栏联动正确，界面精致现代

### 阶段 2：Python 后端
- [ ] 创建 `python-backend/`，`pip install qwen-asr`（锁官方版本）
- [ ] 实现 `asr_engine.py`：模型加载 + `transcribe()` 封装（CPU/CUDA 可切）
- [ ] 实现 `vad.py`：Silero VAD 静音过滤
- [ ] 实现 `app.py`：stdin JSON 监听 + stdout 回传（§7.2 协议全字段）
- [ ] 实现 `api_server.py`：FastAPI 两个端点 + API Key 鉴权（§7.3）
- [ ] 实现音频通道：本地 WebSocket `/ws/live-asr` 二进制流
- [ ] 自测：`curl` 直接调 `/v1/audio/transcriptions` 返回正确文本

### 阶段 3：Rust 主进程
- [ ] 集成热键：组合键用 `tauri-plugin-global-shortcut`；长按 CapsLock 用 `rdev`
- [ ] 实现 Sidecar 启动/退出：`Command::sidecar` + stdin/stdout 管道解析
- [ ] 实现音频转发：录音时把 Rust 采集（或 Python 直采）音频推到 WebSocket
- [ ] 实现上屏：`arboard` 写剪贴板 + `enigo` 模拟 `Ctrl+V`
- [ ] 实现托盘：`tray-icon` 图标 + 菜单（显示主窗口/退出）
- [ ] 实现悬浮条独立窗口（always_on_top，可拖动）
- [ ] 前端 ↔ Rust 通过 `invoke` 打通：开关、热键、设备、API 启停

### 阶段 4：联调
- [ ] 按住 CapsLock 录音 → 松开 → 识别文本上屏到当前输入框
- [ ] 前端 ASR 面板显示：模型状态、设备、实时音量波形
- [ ] API 面板开关 → 拉起/关闭 FastAPI → 第三方 `curl` 调通
- [ ] 配置持久化生效（重启后热键/端口/Key 保留）
- [ ] 错误处理：Python 崩溃自动重启并提示、显存不足提示

### 阶段 5：打包
- [ ] `pyinstaller` 打包 `python-backend` → `qwen-asr-engine-x86_64-pc-windows-msvc.exe` 放入 `src-tauri/binaries/`
- [ ] `tauri.conf.json` 配置 `externalBin` + `resources`
- [ ] `npm run tauri build` 生成安装包/目录版
- [ ] 无 Python 环境的干净 Win10/11 上验证可用

---

## 11. 验收标准（Definition of Done）

- [ ] 三栏布局可用，图标切换正确，UI 现代精致
- [ ] 长按 CapsLock 录音 → 松开 → 文本自动上屏，无人工干预
- [ ] 录音期间悬浮条显示音量波形与状态
- [ ] API 面板可启停服务，`curl -F file=@test.wav http://127.0.0.1:9870/v1/audio/transcriptions` 返回 `{"text": ...}`
- [ ] 启用 API Key 后，无 Key 请求返回 401
- [ ] 设置重启后保留
- [ ] 打包后在无 Python 环境的机器可直接运行

---

## 12. 风险与注意

1. **模型体积/内存**：Qwen3-ASR-0.6B 加载约需 1.2GB+ 内存（bf16 权重），1.7B 更大；文档中所有"内存估算"以实测为准，不在文档臆造数字
2. **版本锁定**：`qwen-asr` 官方要求 `transformers==4.57.6` 等精确版本，requirements 必须锁版本
3. **热键语义**：长按 CapsLock 需要低层键盘钩子（rdev），官方 global-shortcut 插件只支持组合键
4. **上屏需双库**：enigo 只管模拟按键，剪贴板必须用 arboard
5. **Sidecar 命名**：externalBin 文件必须带 target 三元组后缀
6. **音频通道**：音频不要走 stdin JSON（膨胀 33% 且阻塞），走 WebSocket 二进制
7. **并发 OOM**：推理入口串行加锁
8. **打包体积**：qwen-asr 依赖 librosa/soundfile/sox 等，PyInstaller 产物偏大，属正常，勿承诺单文件便携

---

> 本文档是唯一开发依据。功能清单 §4、界面规格 §5、状态 §6、后端规格 §7、系统集成 §8、待办 §10 为可执行规格；§12 为开发中必须遵守的技术注意点。