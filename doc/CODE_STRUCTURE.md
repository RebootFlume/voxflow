# VoxFlow 代码结构说明

> 本文档说明项目代码结构：每个目录 / 文件是干什么的，以及数据流与状态流。
> 技术栈：Tauri v2（Rust 主进程）+ React 19 + Vite 7 + TypeScript + Tailwind（shadcn/ui）+ Zustand。
> 定位：本地语音输入工具（长按热键录音→ASR 识别→剪贴板上屏），内置 OpenAI 兼容 ASR/TTS 服务。

---

## 1. 总体架构

```
┌──────────────────────────── VoxFlow (Tauri v2) ────────────────────────────┐
│                                                                            │
│   src/  React 前端（WebView 渲染层）                                        │
│   三栏 UI（ActivityBar + Sidebar + 面板） + 底部悬浮状态条                     │
│        │ invoke / event                                                    │
│        ▼                                                                   │
│   src-tauri/  Rust 主进程                                                   │
│   - 全局热键（rdev / global-shortcut）  - 托盘 / 剪贴板上屏（arboard+enigo）  │
│   - 模型下载管理（hf-hub）  - 音频采集（cpal）/ 解码（hound）                 │
│   - TTS ONNX 推理（ort）  - ASR GGUF 推理（llama-cpp-2，未接入）              │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
                     │ 读本地模型文件
                     ▼
        models/  Kokoro-82M (ONNX) · Qwen3-ASR (GGUF)
```

**职责划分（重要）**
- `src-tauri/`（Rust）：系统级操作 + 本地推理。热键、托盘、剪贴板、音频采集/解码、模型下载、TTS 推理。
- `src/`（React）：纯 UI + 状态管理。所有后端能力经 Tauri `invoke` 调用，事件经 `listen` 订阅。
- 原 Python Sidecar 已移除，通信协议保留为兼容层（`send_to_sidecar_safe`）。

---

## 2. 目录树

```
voxflow/
├── src/                              # ── React 前端 ──
│   ├── main.tsx                      # 入口：挂载 + 异步初始化（读配置、恢复模型）
│   ├── App.tsx                       # 根组件：三栏布局 + 全局事件订阅/对账 hooks
│   ├── index.css                     # Tailwind + CSS 变量（主题）
│   ├── vite-env.d.ts                 # Vite 客户端类型声明
│   ├── assets/                       # 静态资源（当前空）
│   ├── components/                   # 通用 UI 组件
│   │   ├── TitleBar.tsx              # 自定义无边框标题栏（最小化/最大化/关闭）
│   │   ├── ActivityBar.tsx           # 最左侧 48px 图标栏（模块切换）
│   │   ├── Sidebar.tsx               # 200px 二级菜单
│   │   ├── FloatingBar.tsx           # 底部悬浮状态条（录音/识别状态）
│   │   ├── ModelSelector.tsx         # 模型下拉选择器
│   │   ├── ModelStatusBadge.tsx      # 模型加载状态徽标（idle/loading/ready/error）
│   │   ├── RuntimeLogView.tsx        # 运行日志列表（按级别着色）
│   │   ├── VolumeWave.tsx            # 实时音量波形条
│   │   └── ui/                       # shadcn/ui 封装（Radix 原子组件）
│   ├── lib/                          # 工具与桥接层
│   │   ├── tauri.ts                  # IPC 集中封装：所有 invoke / listen 出口
│   │   ├── i18n.ts                   # 中/英文案字典 + t()
│   │   ├── persistence.ts            # 数据文件读写封装 + 历史记录持久化
│   │   ├── useExportDir.ts           # 共享导出目录 hook（ASR/TTS 共用一份）
│   │   ├── modelState.ts             # 模型类型/已加载判定 + 状态应用的收敛层
│   │   ├── modelLoader.ts            # 模型加载统一入口（单一状态写入路径）
│   │   ├── hf-download.ts            # Hugging Face 下载 TS 封装
│   │   ├── theme.ts                  # 主题同步（dark 模式 + 强调色 CSS 变量）
│   │   └── utils.ts                  # cn() 类名合并
│   ├── modules/                      # 业务面板（按 ActivityBar 模块分组）
│   │   ├── asr/
│   │   │   ├── AsrPanel.tsx          # ASR：热键/模型/状态面板
│   │   │   └── TranscribePanel.tsx   # ASR：音频文件批量转写面板
│   │   ├── tts/
│   │   │   └── TtsPanel.tsx          # TTS：模型/音色/语速/合成面板
│   │   ├── models/
│   │   │   └── ModelsPanel.tsx       # 模型管理：下载/删除/加载/磁盘占用
│   │   ├── api/
│   │   │   └── ApiPanel.tsx          # API 服务：开关/端口/Key/端点状态/测试
│   │   ├── history/
│   │   │   ├── HistoryPanel.tsx      # 历史识别记录（搜索/复制/删除）
│   │   │   └── RuntimeLogsPanel.tsx  # 运行日志面板
│   │   └── settings/
│   │       ├── SettingsPanel.tsx     # 通用设置（悬浮条/语言/关于）
│   │       └── AppearancePanel.tsx   # 外观设置（主题模式/强调色）
│   └── stores/
│       └── app.ts                    # Zustand 全局 store（状态 + actions 唯一真源）
│
├── src-tauri/                        # ── Rust 主进程 ──
│   ├── capabilities/
│   │   └── default.json              # 窗口权限声明（IPC/窗口操作）
│   ├── examples/
│   │   └── hf_download_example.rs    # HF 下载模块使用示例
│   ├── tests/                        # 集成测试
│   │   ├── test_tts_load.rs          # TTS 模型加载/推理测试（需本地模型）
│   │   └── tts_metadata.rs           # 打印 ONNX 模型输入/输出 tensor 元数据
│   ├── gen/schemas/                  # Tauri 生成的 schema（capabilities 自动补全）
│   ├── icons/                        # 应用图标
│   └── src/
│       ├── main.rs                   # 进程入口（Windows 无控制台），调用 lib::run()
│       ├── lib.rs                    # 模块声明 + 全部 Tauri command 注册
│       ├── app_state.rs              # 全局托管状态：ASR/TTS 引擎句柄
│       ├── errors.rs                 # 统一错误类型 AppError（kind + message）
│       ├── model_manager.rs          # 模型注册表/下载管理/代理镜像/状态事件
│       ├── hotkey.rs                 # 热键：CapsLock（rdev）+ 组合键（global-shortcut）
│       ├── clipboard.rs              # 剪贴板上屏：arboard 写 + enigo 模拟 Ctrl+V
│       ├── tray.rs                   # 系统托盘（显示主窗口 / 退出）
│       ├── sidecar.rs                # GPU 检测（nvidia-smi）；Python sidecar 已移除
│       ├── download.rs               # Hugging Face 同步下载器（hf-hub 封装）
│       ├── persistence.rs            # 数据文件读写 command（app data dir）
│       ├── audio/                    # 音频处理（替代 Python soundfile/sounddevice）
│       │   ├── mod.rs                # 常量 + float/int16 转换 + 多声道转单声道
│       │   ├── wav.rs                # WAV 读写（hound），内存解码→16kHz mono
│       │   ├── resample.rs           # 线性重采样
│       │   └── capture.rs            # cpal 麦克风采集 + 输入设备枚举
│       ├── inference/                # 推理引擎（ONNX + GGUF 双引擎抽象）
│       │   ├── mod.rs                # 模块声明
│       │   ├── engine.rs             # InferenceEngine trait / Device / InferInput/Output
│       │   ├── asr.rs                # ASR 引擎（⚠️ 占位，GGUF 推理未接入）
│       │   ├── commands.rs           # ASR 命令桥接（转写/加载/状态查询）
│       │   ├── errors.rs             # InferenceError（AppError 别名）
│       │   └── tests.rs              # 音频解码/重采样/模型加载测试
│       └── tts/                      # TTS 子系统（配置驱动的统一 ONNX 推理）
│           ├── mod.rs                # 模块声明
│           ├── traits.rs             # TtsEngine trait + PipelineContext + TtsResult
│           ├── config.rs             # ModelManifest（manifest.json → 模型差异配置）
│           ├── service.rs            # TtsService 统一调度器（manifest/session/voice）
│           ├── commands.rs           # TTS Tauri 命令（加载/合成/语言/音色列表）
│           ├── engine/
│           │   └── onnx.rs           # GenericOnnxEngine：按 manifest 组装张量推理
│           └── middleware/           # 文本处理中间件（G2P 管道）
│               ├── mod.rs            # Phonemizer trait + segment_text 分段
│               ├── espeak_phonemizer.rs  # espeak-ng → IPA + 回退路由
│               ├── pinyin.rs         # 汉字→拼音→IPA 回退（内嵌大表）
│               ├── vocab_mapper.rs   # IPA → token ids 映射（首尾 $ 边界符）
│               ├── passthrough.rs    # 英文直通 G2P（逐字符小写）
│               └── direct_tokenizer.rs# ⚠️ A 轨直通 tokenizer（未接入，如实报错）
│
├── libs/                             # 二进制运行库
│   ├── onnxruntime-win-x64-1.21.1.zip / onnxruntime-win-x64-1.21.0/lib/  # ONNX Runtime DLL
│   └── llama-server.exe / llama-server-impl.dll                          # llama.cpp 服务端
│
├── models/                           # 本地模型（开发期镜像）
│   ├── Kokoro-82M/  kokoro-82m-onnx/ # TTS ONNX 模型（含 voices/*.bin 音色嵌入）
│   └── qwen3-asr-0.6b-gguf/          # ASR GGUF 模型（含 mmproj 多模态投影）
│
├── public/                           # 静态资源（tauri.svg / vite.svg 图标）
├── dist/                             # 前端构建产物（tauri build 输出）
├── .vscode/extensions.json           # 推荐 VS Code 扩展
│
├── package.json                      # npm 脚本 + 前端依赖
├── vite.config.ts                    # Vite 配置（@ 别名、端口 1494、Tauri 适配）
├── tsconfig.json / tsconfig.node.json# TypeScript 配置
├── tailwind.config.js / postcss.config.js / components.json  # 样式 & shadcn 配置
├── index.html                        # SPA HTML 入口
├── components.json                   # shadcn/ui 配置
├── test_tts.sh                       # TTS 冒烟测试脚本
├── AGENT.md                          # 给 AI/开发者的开发约束
└── *.md                              # 设计/规格文档（见 §5）
```

---

## 3. 逐文件说明

### 3.1 Rust 主进程（src-tauri/）

| 文件 | 职责 |
|---|---|
| `main.rs` | 进程入口。`#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` 使 release 版不弹控制台，然后调用 `voxflow_lib::run()`。 |
| `lib.rs` | **Rust 侧心脏**：声明所有模块 + 注册全部 Tauri command。核心命令：<br>• `send_to_sidecar_safe` — 兼容原 Python sidecar 协议的动作路由（bootstrap / set_model_root / set_mirror / set_proxy / list_models / download_model / cancel_download / delete_model / load_model），内部按模型格式分发到 TTS(ONNX) 或 ASR(GGUF)；<br>• `get_gpu_info` / `decode_audio_file` / `rust_list_audio_devices` / `rust_asr_status` / `rust_load_asr_model` / `rust_transcribe` — 原生推理与设备命令；<br>• `hf_download_file` / `hf_download_as_string` / `hf_download_multiple` — HF 下载命令；<br>• `set_hotkey` — 热键注册入口。 |
| `app_state.rs` | Tauri `manage()` 注入的全局状态。持有 `Arc<Mutex<AsrEngine>>` 与 `Arc<Mutex<TtsService>>`，命令经 `State<AppState>` 访问（替代旧的静态全局变量）。 |
| `errors.rs` | 统一错误类型 `AppError`，序列化为 `{ kind, message }`（kind 是机器可读分类：model_not_found / load_failed / inference_failed / g2p_failed 等），供前端针对性提示。Rust 端不 i18n。 |
| `model_manager.rs` | 模型管理核心：<br>• **注册表** `REGISTRY`：内置 Qwen3-ASR-0.6B/1.7B（GGUF）与 Kokoro-82M / CosyVoice2（ONNX）元数据；<br>• **运行时配置**：模型根目录、HF 镜像、代理（写环境变量 + `ENV_SCOPE_LOCK` 原子化）；<br>• **下载管理**：hf-hub 同步下载、进度事件、取消（panic payload 中断）、删除、磁盘剩余空间（Windows）；<br>• **状态事件**：`emit_models_state` 向 `sidecar://event` 推送模型快照；<br>• **文件定位**：`find_main_model_file`（ONNX 优先非量化 FP32 避开 QDQ 崩溃）、mmproj 查找、目录完整度/大小检测。 |
| `hotkey.rs` | 录音热键。<br>• CapsLock：`rdev` 全局键盘钩子监听 KeyDown/KeyUp，按下→`asr://status=recording`，松开→`recognizing`（当前只同步状态到前端，真实录音未接入）；<br>• 组合键（Alt+Space 等）：`tauri-plugin-global-shortcut` 注册。 |
| `clipboard.rs` | **上屏链路**：`arboard` 写剪贴板 + `enigo` 模拟 Ctrl+V（双库配合，缺一不可）。 |
| `tray.rs` | 系统托盘：菜单「显示主窗口 / 退出」+ 左键单击显示主窗口。 |
| `sidecar.rs` | Python sidecar 已移除后的兼容层，现仅保留 `detect_gpu()`：调 nvidia-smi（<100ms，零依赖）。 |
| `download.rs` | HF 同步下载器封装：`DownloadConfig`（model_id / filename / token / cache_dir）+ `SyncDownloader`（download_file / download_as_string / download_files）。 |
| `persistence.rs` | 数据文件读写：`read_data_file` / `write_data_file` / `get_data_dir`（app data dir，供前端持久化 config/history）。 |

**audio/（音频处理）**

| 文件 | 职责 |
|---|---|
| `mod.rs` | 常量（16k/24k/48k）+ `float_to_int16` / `int16_to_float` / `to_mono`（多声道转单声道）。 |
| `wav.rs` | `read_wav` 读文件、`write_wav` 写 16bit PCM、`decode_audio` 从内存字节流解码并统一为 16kHz mono f32（不写临时文件，避免并发覆盖）。 |
| `resample.rs` | `resample_linear` 线性重采样（对齐 Python np.interp，无外部依赖）。 |
| `capture.rs` | `cpal` 麦克风采集：`AudioCapture`（start/stop/push_chunk 状态机）+ `list_input_devices` / `get_default_input_name` 设备枚举。 |

**inference/（推理引擎）**

| 文件 | 职责 |
|---|---|
| `mod.rs` | 模块声明（ONNX + GGUF 双引擎架构）。 |
| `engine.rs` | 统一抽象：`InferenceEngine` trait、`EngineKind`（Onnx/LlamaCpp/Candle）、`Device`（Cpu/Cuda/Metal/Directml）、`InferInput`（音频/文本）、`InferOutput`（Transcript 等）、`AudioProcessor` trait。 |
| `asr.rs` | ASR 引擎。**⚠️ 占位**：尚未接入 llama-cpp-2 真实推理，`load`/`infer` 诚实返回「未实现」错误（避免前端误以为可用）。 |
| `commands.rs` | ASR 命令桥接：`transcribe_file_rust`（解码文件→引擎推理→返回文本+时长）、`load_asr_model`、`unload_asr_model`、`get_asr_status`。 |
| `errors.rs` | `InferenceError` = `AppError` 历史别名。 |
| `tests.rs` | 测试：WAV 解码、重采样、float/int16 往返、TTS 模型加载/推理管道（需模型，标 `#[ignore]`）、ASR 模型加载。 |

**tts/（TTS 子系统，配置驱动的统一 ONNX 推理）**

| 文件 | 职责 |
|---|---|
| `mod.rs` | 模块声明 + 重新导出 `TtsService` / `TtsEngine`。 |
| `traits.rs` | `TtsEngine` trait（name/load/unload/is_loaded/set_language/infer）+ `PipelineContext`（text/lang/voice/rate）+ `TtsResult`。 |
| `config.rs` | `ModelManifest`：模型差异配置化（不是写死代码）。管道分 **A 轨 Direct**（文本直通 tokenizer，Qwen-TTS 类）与 **B 轨 Phoneme**（G2P→IPA，Kokoro 类）；定义输入张量（tokens/style/speed）、输出候选节点、voices 语言映射。自动探测 `manifest.json` / `kokoro.json`，缺失时按标准 Kokoro 布局生成默认配置。 |
| `service.rs` | `TtsService` 统一调度器：manifest 加载、session 构建、tokenizer vocab 装载、voice embedding 解码（兼容裸 f32 与 torch ZIP）、状态机（Uninitialized/Loading/Ready/Error）、按管道类型分发（Phoneme/Direct）。 |
| `commands.rs` | TTS Tauri 命令：`rust_load_tts_model`（模型名或路径，回退 workspace/models）、`rust_synthesize`（合成并存 WAV，返回时长/大小）、`rust_set_tts_language`（轻量换 voice embedding，不重载模型）、`rust_list_tts_voices`（按语言前缀分组音色，供下拉框）。 |
| `engine/onnx.rs` | `GenericOnnxEngine`：按 manifest 组装 tokens/style/speed 张量 → `ort` 推理 → 按输出候选提取音频（不含任何模型特例）。 |
| `middleware/` | 文本→token 中间件（见下）。 |

**middleware/（G2P 管道中间件）**

| 文件 | 职责 |
|---|---|
| `mod.rs` | `Phonemizer` trait（name/can_handle/phonemize/set_language）+ `segment_text` 按 Unicode 范围分段（Latin/Han/Kana/Punct）。 |
| `espeak_phonemizer.rs` | **B 轨路由**：先把文本分段，再为每段选第一个可处理的 provider（默认 espeak-ng → 拼音回退 → 英文直通）。espeak-ng 走 `-v {lang} --ipa` 产出 IPA；不可用时中文回退 `PinyinG2p`、英文回退 `PassthroughG2p`。 |
| `pinyin.rs` | 中文回退 G2P：汉字→拼音（内嵌 3799 字 Unihan 表）→ IPA（430 个音节表），全部符号取自 Kokoro 音素表白名单，保证可映射。 |
| `vocab_mapper.rs` | `ipa_to_token_ids`：IPA 序列 → vocab id，首尾加边界符 `$`，未命中音素跳过。 |
| `passthrough.rs` | 英文直通：纯 ASCII 文本逐字符小写即为音素 token（Kokoro 音素表直接含 a–z）。 |
**src-tauri 其它目录**

| 目录/文件 | 说明 |
|---|---|
| `capabilities/default.json` | 主窗口权限声明（core:default、opener/dialog 插件、窗口最小化/最大化/关闭/拖拽）。 |
| `examples/hf_download_example.rs` | HF 下载模块使用示例（`cargo run --example` 可跑）。 |
| `tests/` | 集成测试：`test_tts_load.rs`（TTS 加载/推理，需本地模型）、`tts_metadata.rs`（打印 ONNX 模型输入输出 tensor 名）。 |
| `gen/schemas/` | Tauri 自动生成的 schema（capabilities JSON 自动补全用，勿手改）。 |

### 3.2 React 前端（src/）

| 文件 | 职责 |
|---|---|
| `main.tsx` | 入口。挂载 React + 异步初始化：`initPersistence()` 读配置 → `sendToSidecar({action:"bootstrap"})` 下发模型根目录/镜像/代理 → 自动纠偏 `useRustEngine` → 恢复上次加载的 ASR/TTS 模型。 |
| `App.tsx` | 根组件：三栏布局（TitleBar + ActivityBar + Sidebar + 主面板）+ 底部 FloatingBar。**全局事件中枢**：<br>• `useSidecarEvents` — 订阅 `sidecar://event`（模型状态、下载进度、识别结果、TTS/转写任务、API 状态、音量等）与 `asr://status`（热键状态），驱动 store + 运行日志；<br>• `useHotkeySync` — 热键变更同步 Rust；<br>• `useStartupFallback` / `useStatusReconcile` / `useModelLoadTimeout` — 启动兜底查询、状态对账、加载超时纠偏。 |
| `stores/app.ts` | **全局状态唯一真源**（Zustand）。状态域：activeModule/activeSubMenu、asr、tts、api、transcribe、io（共享导出目录）、audioDevices、gpu、capabilities、models（含下载进度/已加载模型）、overlay、theme、runtimeLogs、history、transcribeTasks、ttsTasks、useRustEngine、locale。全部 actions（updateAsr/updateTts/applyModelsState/applyDownloadProgress/addLog/任务 CRUD…）集中于此。 |
| `lib/tauri.ts` | **IPC 桥接层**：所有 `invoke` / `listen` 集中封装（sendToSidecar / onSidecarEvent / rustLoadAsrModel / rustSynthesize / …），便于 mock 与替换。 |
| `lib/i18n.ts` | 中/英文案字典 + `t(locale, key)`。 |
| `lib/persistence.ts` | `loadData` / `saveData`（调用 Rust persistence 命令）+ 历史记录加载/保存。 |
| `lib/useExportDir.ts` | 共享导出目录 hook：ASR 转写与 TTS 合成共用同一份目录。 |
| `lib/modelState.ts` | **收敛层**：`resolveModelKind`（按 models.items[].kind 判定模型类型）、`computeIsLoaded`（统一「是否已加载」公式）、`applyModelStatus`（统一状态写入路径）。 |
| `lib/modelLoader.ts` | **模型加载单一入口**：乐观置 loading → 调 Rust → 按结果回写 ready/error + 记日志。所有 UI 加载都必须走这里。 |
| `lib/hf-download.ts` | HF 下载 TS 封装（类型安全 invoke 包装）。 |
| `lib/theme.ts` | `useThemeSync`：同步 `documentElement` 的 `.dark` 与 `--primary/--ring` CSS 变量。 |
| `lib/utils.ts` | `cn()`（clsx + tailwind-merge）。 |

**components/（通用组件）**

| 文件 | 职责 |
|---|---|
| `TitleBar.tsx` | 自定义无边框标题栏：最小化 / 最大化 / 关闭（Tauri window API）。 |
| `ActivityBar.tsx` | 最左侧 48px 图标栏：模块切换（ASR/TTS/API/历史/模型/设置）+ 侧栏折叠。 |
| `Sidebar.tsx` | 200px 二级菜单，按当前模块显示对应子项（数据源 `DEFAULT_SUB_MENUS`）。 |
| `FloatingBar.tsx` | 底部悬浮状态条：空闲/录音中/识别中/成功/失败 + 音量波形 + 模块快捷入口。 |
| `ModelSelector.tsx` | 模型下拉选择器（按 kind/format 过滤）。 |
| `ModelStatusBadge.tsx` | 模型加载状态徽标（idle/loading/ready/error），ASR/TTS 共用。 |
| `RuntimeLogView.tsx` | 运行日志渲染（按级别着色，自动滚动到底）。 |
| `VolumeWave.tsx` | 24 根柱子的音量波形（录音中高亮）。 |
| `ui/` | shadcn/ui 组件（Radix 封装）：button / card / input / select / slider / switch / tabs / textarea / badge / progress / separator / scroll-area / tooltip。 |

**modules/（业务面板）**

| 文件 | 职责 |
|---|---|
| `asr/AsrPanel.tsx` | ASR 配置：热键输入（含 CapsLock/组合键）、模型与设备选择、模型状态徽标、音量波形。 |
| `asr/TranscribePanel.tsx` | 音频文件转写：选文件 → 队列任务 → 进度 → 结果/保存导出。 |
| `tts/TtsPanel.tsx` | TTS 合成：模型/音色/语速滑块/语言 + 文本框合成试听 + 任务列表。 |
| `models/ModelsPanel.tsx` | 模型管理：模型列表（下载/删除/加载/取消）、磁盘占用、镜像/代理/根目录设置。 |
| `api/ApiPanel.tsx` | API 服务配置：开关、host/port、API Key、端点状态灯、测试控制台（curl 复制）。 |
| `history/HistoryPanel.tsx` | 历史识别记录：搜索 / 复制 / 删除 + 运行日志入口。 |
| `history/RuntimeLogsPanel.tsx` | 运行日志面板（清空 + 列表）。 |
| `settings/SettingsPanel.tsx` | 通用设置：悬浮条开关、语言切换、关于。 |
| `settings/AppearancePanel.tsx` | 外观设置：主题模式（system/light/dark）+ 强调色预设。 |

### 3.3 静态资源与第三方

| 目录/文件 | 说明 |
|---|---|
| `libs/` | ONNX Runtime（onnxruntime-win-x64）DLL + llama.cpp `llama-server.exe`。Rust `ort` / `llama-cpp-2` 运行期依赖。 |
| `models/` | 开发期模型镜像：`Kokoro-82M` / `kokoro-82m-onnx`（TTS ONNX + voices/af.bin 音色嵌入）、`qwen3-asr-0.6b-gguf`（ASR GGUF + mmproj）。 |
| `public/` | 静态图标（tauri.svg / vite.svg）。 |
| `dist/` | `vite build` 产物，`tauri build` 打包用。 |
| `.vscode/extensions.json` | 推荐扩展。 |

---

## 4. 关键数据流

### 4.1 前端 ↔ Rust 通信

- **请求**：React `lib/tauri.ts` → `invoke("command", args)` → Rust `#[tauri::command]`（在 `lib.rs` / `tts::commands` / `persistence` 注册）。
- **推送**：Rust `app.emit("sidecar://event", payload)` → 前端 `onSidecarEvent`（`lib/tauri.ts`）→ `App.tsx useSidecarEvents` → store actions → 各面板订阅更新。
- **热键状态**：Rust `hotkey.rs` emit `asr://status` → `App.tsx listen("asr://status")`。

### 4.2 模型加载链路（单一真源）

```
UI 发起 → modelLoader.ts（乐观置 loading）
        → rust_load_*_model（Rust 查找模型文件 → 分发 ONNX/GGUF 引擎）
        → 结果回写 ready/error + addLog
        → Rust 侧 emit model_ready/model_error → App.tsx applyModelStatus 兜底纠偏
```

### 4.3 TTS 合成管道

```
文本 → segment_text 分段
     → [B 轨 Phoneme] espeak-ng→IPA → vocab_mapper→token_ids
       （espeak 不可用：中文走 pinyin 回退、英文走 passthrough）
     → [A 轨 Direct] 直接 tokenizer（未接入）
→ GenericOnnxEngine 按 manifest 组装张量推理 → 音频 → 存 WAV → tts_done 事件
```

---

## 5. 根目录文档

| 文档 | 内容 |
|---|---|
| `README.md` | 项目开发规格书（唯一开发依据）：功能清单、界面规格、状态定义、后端协议。 |
| `技术重构文档.md` | Python sidecar → Rust 原生迁移的架构决策与阶段规划。 |
| `TTS引擎架构与G2P管道技术说明.md` | TTS 引擎分层与 G2P（A 轨 Direct / B 轨 Phoneme）设计。 |
| `TODO-TTS-重构.md` / `TODO.md` | TTS 重构与总体待办。 |
| `CapsWriter开发：Tauri与Electron选型对比.md` | 技术选型对比（历史决策记录）。 |
| `AGENT.md` | 给 AI/开发者的开发约束。 |

---

## 6. 当前实现状态提醒

以下模块为**诚实占位**（未完成，代码如实报错而非假装可用）：

- `inference/asr.rs` — ASR GGUF 推理未接入 llama-cpp-2（`load`/`infer` 返回「未实现」）。
- `tts/middleware/direct_tokenizer.rs` — A 轨 Direct 管道未接入 HF tokenizer。
- `lib.rs` `load_model` GGUF 分支 — 打印「GGUF engine not implemented yet」。
- `hotkey.rs` — 热键目前只同步状态到前端，未触发真实录音。
- `models/` 下 `CosyVoice2-0.5B` 注册为 `available: false`（ONNX 覆盖不完整）。
