# VoxFlow 项目文档

> 最后更新：2026-08-25
> 本文档整合 CODE_STRUCTURE / TODO-TTS-重构 / TTS引擎架构 / 技术重构文档，统一为一份项目全景文档。

---

## 1. 项目定位

本地语音输入工具。用户按住热键录音 → ASR 实时识别 → 文字上屏到当前输入框。内置 TTS（文本转语音）与 OpenAI 兼容 API 服务。

**核心价值**：零网络依赖、毫秒级识别、开箱即用。

---

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Tauri v2（Rust 主进程 + WebView） |
| 前端 | React 19 + Vite 7 + TypeScript + Tailwind（shadcn/ui） + Zustand |
| TTS 推理 | ONNX Runtime（ort 2.0-rc.13 + DirectML） |
| ASR 推理 | llama-cpp-2（GGUF，⚠️ 尚未接入） |
| 音频 | cpal（采集） + hound（WAV 解码） + 线性重采样 |
| 模型下载 | hf-hub 1.0（HuggingFace，支持镜像/代理） |
| G2P | espeak-ng 1.52（捆绑在 resources/）+ 拼音回退 |

---

## 3. 当前状态

### ✅ 已完成

| 模块 | 状态 |
|---|---|
| UI 框架（三栏布局 + 无边框 + 托盘 + 全局热键） | ✅ 完成 |
| 前端状态管理（Zustand 单一真源 + IPC 桥接） | ✅ 完成 |
| 模型下载管理（HuggingFace 下载/镜像/代理/进度） | ✅ 完成 |
| TTS 模型加载 + ONNX 推理 | ✅ 完成 |
| TTS G2P（espeak-ng 捆绑 + 拼音回退 + 英文直通） | ✅ 完成 |
| TTS 合成 + WAV 导出 | ✅ 完成 |
| TTS 语言切换（voice embedding 换装） | ✅ 完成 |
| 语音识别（CapsLock 热键 → 状态） | ✅ 骨架完成 |
| 剪贴板上屏（arboard + enigo 模拟 Ctrl+V） | ✅ 完成 |
| 数据持久化（config / history） | ✅ 完成 |
| i18n（中/英文案） | ✅ 完成 |

### ⚠️ 未完成 / 已知问题

| 模块 | 问题 |
|---|---|
| **ASR 推理** | `llama-cpp-2` crate 尚未接入，`asr.rs` 诚实报错"未实现" |
| **TTS 音色（voice）** | 前端"音色"下拉（default/female/male）→ Rust `_voice` 参数被忽略，实际音色完全由语言下拉决定 |
| **TTS voice 行索引** | 官方 `voices[len(tokens)]` 按音素长度选 style 行，代码取 `f32[0..256]`（固定第0行）；实测差异微小但仍是偏差 |
| **TTS 中文合成** | 模型为英文版（`onnx-community/Kokoro-82M-ONNX`），无中文音色，中文合成需多语言模型 |
| **espeak-ng 日/中音素** | espeak-ng 输出的日/中文 IPA 包含 tone marker（`2`/`5`）、combining mark 等不在 Kokoro vocab 中的符号，会静默丢弃 |
| **`libs/` 目录混乱** | onnxruntime DLL/pdb（354MB）+ 旧版本 + llama-server 等散落，代码不引用 |
| **`models/` 目录重复** | `models/Kokoro-82M/`（有效）+ `models/kokoro-82m-onnx/`（冗余，仅 Q8F16 量化版） |
| **磁盘占用** | models/ 1.4GB + libs/ 368MB + 模型 PDB 354MB，总计 ~2GB 开发依赖 |

---

## 4. 架构

### 4.1 运行时架构

```
┌──────────────────────────────────────────────────────────────┐
│  VoxFlow (Tauri v2)                                          │
│                                                              │
│  src/ React 前端     ── invoke / listen ──  src-tauri/ Rust   │
│  (WebView)                                    (主进程)        │
│                                                  │           │
│              ┌───────────────────────────────────┤           │
│              │          推理引擎                   │           │
│              │  ┌──────────────┬──────────────┐  │           │
│              │  │ ONNX (ort)   │ GGUF (llama) │  │           │
│              │  │ TTS ✅       │ ASR ⚠️ 未接入 │  │           │
│              │  └──────────────┴──────────────┘  │           │
│              └───────────────────────────────────┘           │
│                          │                                   │
│                  读 models/ 目录                              │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 模型目录结构

```
models/
├── Kokoro-82M/          ← TTS（ONNX，310MB FP32 + 83MB Q8F16）
│   ├── onnx/model.onnx ← 主模型（被代码使用）
│   ├── tokenizer.json  ← 音素词表（115个符号）
│   └── voices/af.bin   ← 美式英语女声音色（仅此一个）
├── kokoro-82m-onnx/     ← ⚠️ 冗余（仅 Q8F16 量化版，已弃用）
└── qwen3-asr-0.6b-gguf/← ASR（GGUF，804MB + 214MB mmproj，未接入）
```

### 4.3 TTS 管道（Phoneme Pipeline）

```
文本 → segment_text（按Unicode分段）
  │
  ├─ Latin 段 → EspeakPhonemizer(-v en-us --ipa) → IPA 符号
  ├─ Han 段   → EspeakPhonemizer(-v cmn) 或 PinyinPhonemizer → IPA 符号
  ├─ Kana 段  → EspeakPhonemizer(-v jap) → IPA 符号
  └─ 其它     → 直通 / 丢弃
      │
      ▼
  ipa_to_token_ids（首尾加 $ 边界符）
      │
      ▼
  GenericOnnxEngine::run（tokens + style[256] + speed → waveform）
      │
      ▼
  f32→i16 → WAV 文件 / 播放
```

---

## 5. TTS 子系统详细说明

### 5.1 Kokoro-82M 模型特性

| 特性 | 说明 |
|---|---|
| 参数量 | 82M |
| 音频格式 | 24kHz mono f32 |
| 上下文长度 | 512 tokens（含 $ 边界符） |
| 音素表 | 115 个 IPA 符号 + 字母 + 标点（tokenizer.json） |
| 管道类型 | Phoneme（需 G2P，不是端到端） |
| 音色 | voice embedding 256维，按音素长度索引（512行×256维） |
| 多语言 | 需 v1.0 模型 + jf_*/zf_* 音色文件；当前 ONNX 版仅英文 |

### 5.2 语言 ↔ 音色 映射

Kokoro 的"语言"本质是**音色口音**：每个 voice 文件（af.bin / jf.bin / zf.bin 等）编码了特定口音的 256 维 embedding。选择"Japanese"语言 = 加载 jf_* 音色 = 英文文本也会被读成日语腔调。

当前 `onnx-community/Kokoro-82M-ONNX` 仅有 11 个英文音色（af/am/bf/bm），语言下拉实际只支持 "en"。

### 5.3 G2P 音素生成（修复后）

| Provider | 条件 | 输出 |
|---|---|---|
| **EspeakPhonemizer**（优先） | resources/espeak-ng/ 存在 | 正确 IPA（h ə l ˈ o ʊ …） |
| **PinyinPhonemizer**（回退） | 汉字 + 无 espeak | 拼音→IPA（n i h a ʊ …） |
| **PassthroughPhonemizer**（兜底） | 纯 ASCII + 无 espeak | 逐字母小写（h e l l o …，⚠️ 元音不准） |

### 5.4 已修复问题（2026-08-24）

| 问题 | 修复 |
|---|---|
| 英文 G2P 产出字母而非 IPA → "日语腔" | 捆绑 espeak-ng 1.52，正确产出 h ə l ˈ o ʊ |
| espeak-ng voice 跟随下拉而非文本 | 改为按文本 Unicode 自动检测（en-us/cmn/jap） |
| set_language 缺 voice 文件静默回退 | 严格校验，报错并列出可用语言 |
| 前端语言默认 "zh" 与模型不匹配 | load 后自动对齐到 Rust 实际可用语言 |
| G2P 命名混乱（G2p 后缀） | 统一为 XxxPhonemizer + PhonemizerRouter |

---

## 6. 文件清理

### 6.1 应删除

| 路径 | 原因 | 省空间 |
|---|---|---|
| `models/kokoro-82m-onnx/` | 冗余（仅 Q8F16，已知段错误） | -83 MB |
| `libs/onnxruntime-win-x64-1.21.0/` | 旧版 ORT SDK，ort crate 自带 runtime | -368 MB |
| `libs/onnxruntime-win-x64-1.21.1.zip` | 9字节损坏文件 | -0 |
| `libs/onnxruntime.dll.bak` | 旧备份 | -10 MB |
| `libs/llama-server.exe` | llama-cpp-2 crate 未接入，无用 | -24 KB |
| `libs/llama-server-impl.dll` | 同上 | -6 MB |
| `models/Kokoro-82M/onnx/model_q8f16.onnx` | 已知段错误，不会被选中 | -83 MB |
| `models/Kokoro-82M/.cache/` | HuggingFace 下载缓存 | -少量 |

### 6.2 应加入 .gitignore

```
models/
libs/
```

---

## 7. 待讨论事项

### 7.1 ASR 接入：llama-cpp-2 还是等 GGUF 替代方案？

llama-cpp-2 crate 目前版本（0.1）是否稳定？是否等 ASR 模型出现 ONNX 版（SenseVoice/Paraformer）再接入？

### 7.2 多语言 TTS：用哪版模型？

| 方案 | 模型 | 大小 | 多语言 |
|---|---|---|---|
| A | `hexgrad/Kokoro-82M`（PyTorch） | ~200MB | ✅（需导出 ONNX） |
| B | `onnx-community/Kokoro-82M-v1.0-ONNX` | ~300MB | ✅（官方 ONNX） |
| C | 不做多语言，当前仅英文 | 310MB | ❌ |

### 7.3 音色选择 UI

当前语言下拉实际控制音色。是否改为：
- 下拉显示"音色名（美式女声）"而非"语言名"
- 或保留"语言"标签但提示"选择口音"

### 7.4 voice 行索引修正

是否修正 `af.bin` 的 style 行索引（按 `len(tokens)` 选行）？实测差异微小，是否值得改？

### 7.5 开发环境配置

用户提到 Python 版配置正确后模型加载 <1 秒。Rust 版 ort 2.0-rc.13 + DirectML 的首次加载耗时需排查（是 onnxruntime DLL 编译优化问题？还是 mmap 未启用？）。
