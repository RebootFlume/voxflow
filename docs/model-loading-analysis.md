# VoxFlow 模型加载机制分析

## 一、总体架构：两条独立的引擎管道

项目中 ASR（语音识别）和 TTS（语音合成）各有独立的 Rust 引擎，但共享同一套前端调用框架和状态管理模式。

```
┌─────────────────────────────────────────────────────────────────────┐
│ 前端触发层（4 个入口 × 2 引擎）                                       │
│  main.tsx 启动自动加载                                               │
│  AsrPanel / TtsPanel 用户切换设备/模型                                │
│  ModelsPanel 用户点"加载"按钮                                         │
└──────────────┬──────────────────────────┬───────────────────────────┘
               │ loadAsrModel()           │ loadTtsModel()
               ▼                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│ modelLoader.ts — 统一入口（单一真源）                                  │
│  1. 乐观置为 loading（立即反馈）                                      │
│  2. invoke Rust 命令                                                │
│  3. 按结果回写 ready / error（并记日志）                               │
└──────────────┬──────────────────────────┬───────────────────────────┘
               │ invoke                   │ invoke
               ▼                          ▼
┌────────────────────────────┐  ┌────────────────────────────────────┐
│ tauri.ts:                  │  │ tauri.ts:                          │
│  rustLoadAsrModel()        │  │  rustLoadTtsModel()                │
│  → invoke("rust_load_asr.. │  │  → invoke("rust_load_tts..         │
└──────────────┬─────────────┘  └──────────────┬─────────────────────┘
               │                               │
               ▼                               ▼
┌────────────────────────────┐  ┌────────────────────────────────────┐
│ Rust: lib.rs               │  │ Rust: tts/commands.rs              │
│  rust_load_asr_model()     │  │  rust_load_tts_model()             │
│  → model_manager 定位文件   │  │  → model_manager 定位文件           │
│  → AsrEngine.load()        │  │  → TtsService.load()               │
│  → emit model_ready        │  │  → emit model_ready                │
└──────────────┬─────────────┘  └──────────────┬─────────────────────┘
               │                               │
               ▼                               ▼
┌────────────────────────────┐  ┌────────────────────────────────────┐
│ 状态更新                     │  │ 状态更新                           │
│  ASR: invoke 同步返回 ready │  │  TTS: 异步事件 model_ready → ready │
│  useSidecarEvents 兜底对账  │  │  useSidecarEvents 兜底对账         │
└────────────────────────────┘  └────────────────────────────────────┘
```

---

## 二、共用的框架（相同的骨架）

### 1. 前端统一入口 `src/lib/modelLoader.ts`

所有加载都必须经过这里，这是**单一真源**：

```typescript
// ASR 和 TTS 遵循相同模式：
// 1. 立即乐观置 loading
// 2. invoke Rust
// 3. 成功 → ready / 失败 → error + 日志
```

**区别**：ASR 的 `loadAsrModel` 在 invoke resolve 时直接置 ready；TTS 的 `loadTtsModel` 注释说明"ready 由 model_ready 事件异步驱动"，invoke resolve 后不立即置 ready。

### 2. 文件定位 `src-tauri/src/model_manager.rs`

ASR 和 TTS 共用同一套模型文件发现逻辑：
- `model_manager::model_dir(name)` → 根据模型名拼接 modelRoot 路径
- `model_manager::find_main_model_file(dir, format)` → 递归扫描找到主模型文件（GGUF 取最大排除 mmproj；ONNX 优先非量化模型）
- `ModelManifest::resolve_model_root(model_path)` → 从模型文件向上定位根目录（TTS 独用）

### 3. 事件驱动状态更新 `src/hooks/useSidecarEvents.ts`

两个引擎都通过同一事件监听器更新状态：
- `model_ready` → 对应引擎 → `ready`
- `model_error` → 对应引擎 → `error`
- `model_loading` → 对应引擎 → `loading`
- `model_evicted` → 显存不足释放

### 4. 状态持久化

通过 zustand persist（`localStorage("voxflow-config")`）持久化：
- `asr.model`、`asr.device`
- `tts.model`、`tts.device`、`tts.language`、`tts.voice`

---

## 三、不同的实现（两套引擎）

| 维度 | ASR | TTS |
|------|-----|-----|
| 格式 | GGUF（llama-cpp-2） | ONNX（ort） |
| Rust 引擎 | `AsrEngine`（inference/asr.rs） | `TtsService`（tts/service.rs） |
| trait | `InferenceEngine`（engine.rs） | `TtsEngine`（traits.rs） |
| state 位置 | `state.asr`（Mutex） | `state.tts`（Mutex） |
| 文件扫描扩展名 | `.gguf`（排除 mmproj） | `.onnx`（优先非量化模型） |
| ready 回写时机 | invoke resolve 同步置 ready | 通过 `model_ready` 事件异步置 ready |
| manifest 支持 | 无 | 有（`ModelManifest`：张量名、输入输出、voice 路径） |
| 语言/音色切换 | 无（单语言模型） | `set_language()` + `load_voice()` |

---

## 四、所有加载触发点（共 8 个）

### ASR 加载（4 个触发点）

| # | 位置 | 时机 | 守卫条件 |
|---|------|------|----------|
| ① | `main.tsx` | **启动时立即** | `asr.model` 非空 |
| ② | `AsrPanel.tsx` | 用户切换设备 | 无（直接调用） |
| ③ | `AsrPanel.tsx` | 用户选择模型 | 无（ModelSelector.onSelect） |
| ④ | `ModelsPanel.tsx` | 用户点"加载"按钮 | 模型已下载 |

### TTS 加载（4 个触发点）

| # | 位置 | 时机 | 守卫条件 |
|---|------|------|----------|
| ① | `main.tsx` | **启动后延迟 3 秒** | `tts.model` 非空 + 非 loading + 非 ready |
| ② | `TtsPanel.tsx` | 用户切换设备 | 无（直接调用） |
| ③ | `TtsPanel.tsx` | 用户选择模型 | 无（ModelSelector.onSelect） |
| ④ | `ModelsPanel.tsx` | 用户点"加载"按钮 | 模型已下载 |

### 隐藏加载（调试用）

| # | 位置 | 说明 |
|---|------|------|
| ⑤ | `lib.rs` `rust_test_tts_model` | 硬编码加载 `Kokoro-82M`，UI 无入口，仅开发调试 |

---

## 五、Tauri 命令注册（Rust 侧）

```rust
// src-tauri/src/lib.rs invoke_handler 注册：
rust_load_asr_model,        // ASR 加载
rust_load_tts_model,        // TTS 加载（从 tts::commands 抽出）
rust_test_tts_model,        // 调试用 TTS 加载
```

Rust 命令文件分布：
- `src-tauri/src/lib.rs` — ASR 加载命令 `rust_load_asr_model`
- `src-tauri/src/tts/commands.rs` — TTS 加载命令 `rust_load_tts_model`
- `src-tauri/src/inference/commands.rs` — ASR 底层 `load_asr_model`
- `src-tauri/src/tts/service.rs` — TTS 底层 `TtsService::load`

---

## 六、启动时的完整加载时序

```
1. React 渲染 → useAppStore.create() → zustand persist 从 localStorage 同步恢复
2. main.tsx (async):
   2a. await initPersistence()
       → loadConfig()：检查 localStorage 是否有 voxflow-config
         → 有：跳过 config.json（不再覆盖）
         → 无：从 config.json 迁移一次（老用户升级）
   2b. 发送 bootstrap 给 Rust 端（model_root、mirror、proxy）
   2c. loadAsrModel(asr.model, asr.device) — 立即执行
       → ASR engine 开始加载 → emit model_ready → ready
   2d. setTimeout(3s):
       检查 tts.model && ttsModelStatus !== "loading" && !== "ready"
       → loadTtsModel(tts.model, tts.device)
       → TTS engine 开始加载 → emit model_ready → ready
```

---

## 七、已修复的 Bug

### Bug：启动时总是加载 Kokoro-82M（即使已切换模型）

**根因**：`config.json` 是旧版遗留产物，项目中已无写入逻辑（永不更新），但 `loadConfig()` 每次启动都会用其中的旧 `tts.model="Kokoro-82M"` 覆盖 zustand persist 恢复的最新值。

**修复**：`loadConfig()` 增加守卫 —— 若 localStorage 已有持久化数据（`voxflow-config`），直接跳过 config.json 的读取。config.json 仅在首次迁移时使用。

---

## 八、模型文件解析（Rust 侧）

### ASR 模型文件发现流程
```
输入：模型名（如 "Qwen3-ASR-0.6B"）
  → model_manager::model_dir("Qwen3-ASR-0.6B")
    → AppData/Roaming/com.voxflow.app/models/Qwen3-ASR-0.6B/
  → find_main_model_file(dir, Gguf)
    → 递归扫描 .gguf 文件（排除 mmproj）
    → 取最大的那个
  → 实际路径：.../Qwen3-ASR-0.6B/ggml-qwen3-asr-0_6b.gguf
```

### TTS 模型文件发现流程
```
输入：模型名（如 "Qwen3-TTS-0.6B"）
  → model_manager::model_dir("Qwen3-TTS-0.6B")
    → AppData/Roaming/com.voxflow.app/models/Qwen3-TTS-0.6B/
  → find_main_model_file(dir, Onnx)
    → 递归扫描 .onnx 文件
    → 优先非量化模型（排除 model_q*）
    → 取最大的那个
  → 实际路径：.../Qwen3-TTS-0.6B/onnx/model.onnx
  → ModelManifest::load(model_root)
    → 优先读取 manifest.json / kokoro.json
    → 缺失时按标准 Kokoro 布局自动生成默认配置
```

---

## 九、关键文件索引

| 文件 | 作用 |
|------|------|
| `src/main.tsx` | 启动入口，触发初始模型加载 |
| `src/lib/modelLoader.ts` | 加载统一入口（ASR + TTS） |
| `src/lib/tauri.ts` | Tauri IPC 桥接层 |
| `src/lib/persistence.ts` | 配置持久化（config.json 迁移） |
| `src/stores/index.ts` | zustand store + persist 配置 |
| `src/stores/slices/ttsSlice.ts` | TTS 状态定义 |
| `src/stores/slices/asrSlice.ts` | ASR 状态定义 |
| `src/hooks/useSidecarEvents.ts` | 事件驱动状态更新 |
| `src/modules/tts/TtsPanel.tsx` | TTS UI 面板（设备/模型选择） |
| `src/modules/asr/AsrPanel.tsx` | ASR UI 面板（设备/模型选择） |
| `src/modules/models/ModelsPanel.tsx` | 模型管理面板（下载/加载/删除） |
| `src-tauri/src/lib.rs` | ASR 加载命令 + Tauri 命令注册 |
| `src-tauri/src/model_manager.rs` | 模型文件发现与下载管理 |
| `src-tauri/src/tts/commands.rs` | TTS 加载命令 |
| `src-tauri/src/tts/service.rs` | TTS 引擎（TtsService::load） |
| `src-tauri/src/tts/config.rs` | ModelManifest（模型元数据配置） |
| `src-tauri/src/inference/commands.rs` | ASR 底层加载命令 |
| `src-tauri/src/inference/engine.rs` | ASR 引擎 trait 定义 |
