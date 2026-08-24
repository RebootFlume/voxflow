# TTS 引擎架构与 G2P 管道技术说明

> 本文档描述 VoxFlow TTS 子系统的引擎架构、G2P（Grapheme-to-Phoneme）管道设计、多语言统一处理方案，以及各模块的职责边界与扩展方式。

---

## 1. 设计目标

- **可插拔引擎**：不同 TTS 模型（Kokoro、Edge-TTS、CosyVoice 等）通过统一接口接入，前端无感知切换。
- **多语言统一**：不为每种语言引入不同 Crate，统一使用 `espeak-ng` 绑定层按语言代码产出 IPA 音素。
- **管道可组合**：后端根据模型类型选择 Direct Pipeline 或 Phoneme Pipeline，避免繁琐条件分支。
- **状态健壮**：所有加载/合成操作走统一 Action → Store 单一真源，UI 不依赖脆弱的事件猜测。

---

## 2. 核心架构：双轨制流水线 (Dual Pipeline Architecture)

后端根据模型的 `PipelineType` 将推理流程拆分为两条路径：

### A. Direct Pipeline（端到端直接分词模式）

```
原始文本 ──► HuggingFace tokenizers Crate ──► Token IDs Tensor ──► ONNX 推理 ──► 音频输出
```

| 适用模型 | 说明 |
|---|---|
| Qwen-TTS | 文本直接 tokenizer 化，无需 G2P |
| Chatterbox | 同上 |
| TADA | 同上 |

### B. Phoneme Pipeline（音素预处理模式）

```
原始文本 ──► espeak-ng（按 lang 输出 IPA 音素）──► Token Vocab 映射 ──► Token IDs Tensor ──► ONNX 推理 ──► 音频输出
```

| 适用模型 | 说明 |
|---|---|
| Kokoro-82M | 轻量音素模型，需 G2P |
| LuxTTS | 同上 |
| 未来轻量模型 | 同上 |

**选择逻辑**（伪代码）：

```rust
fn run_pipeline(model: &Model, text: &str, lang: &str) -> Result<Audio> {
    match model.pipeline_type {
        PipelineType::Direct => {
            let token_ids = tokenizer.encode(text);
            model.infer(token_ids, ...)
        }
        PipelineType::Phoneme => {
            let ipa = espeak_ng::phonemize(text, lang);
            let token_ids = vocab.lookup(ipa);
            model.infer(token_ids, ...)
        }
    }
}
```

---

## 3. 多语言统一收拢 (Unified Multilingual Handling)

### 原则

**坚决不针对每种语言单独引入不同 Crate。** 统一使用 `espeak-ng` 绑定层，传入语言代码（如 `"zh"`, `"en"`, `"ja"`, `"fr"`, `"es"` 等），直接产出 IPA 音素。

### 语言代码 → espeak-ng 映射

| 语言 | 代码 | espeak-ng voice | 说明 |
|---|---|---|---|
| 中文（普通话） | `zh` | `cmn` 或 `zh` | eSpeak 内置 |
| 英语 | `en` | `en` 或 `en-us` | eSpeak 内置 |
| 日语 | `ja` | `jap` | eSpeak 内置 |
| 法语 | `fr` | `fr` | eSpeak 内置 |
| 西班牙语 | `es` | `es` | eSpeak 内置 |
| 韩语 | `ko` | `ko` | eSpeak 内置 |

### 工作原理

```
中文文本 "你好世界"
    │
    ▼ espeak-ng -v zh
IPA 输出: n ɪ h ɑʊ ʂ ɨ d ʂ ɛ
    │
    ▼ Token Vocab 映射
Token IDs: [0, 50, 47, 120, ...]
    │
    ▼ ONNX 推理
音频: 24kHz mono int16
```

### 不使用 espeak-ng 的回退

`espeak-ng` 可能未安装（如纯 Windows 无 espeak-ng）。回退策略：

1. **Pip-level 回退**：对 Phoneme Pipeline，如果 `espeak-ng` 不可用，使用内置的轻量 G2P（如拼音→IPA 映射表覆盖中文，英文字母直通）。
2. **Direct Pipeline 不受影响**：Qwen-TTS 等模型不依赖 G2P，不受 espeak-ng 可用性影响。
3. **日志警告**：明确提示 `espeak-ng not found, using fallback G2P`。

---

## 4. 模块职责划分

```
src-tauri/src/
├── g2p/                          # G2P 管道（独立工具模块）
│   ├── mod.rs                    #   G2pProvider trait + G2pRouter
│   ├── espeak.rs                 #   espeak-ng 绑定（Phoneme Pipeline）
│   ├── pinyin.rs                 #   中文回退：拼音→IPA（无 espeak 时）
│   └── passthrough.rs            #   英文直通 / 无需 G2P
├── inference/
│   ├── engine.rs                 #   InferenceEngine trait（统一接口）
│   ├── tts.rs                    #   TTS 引擎抽象（包装 g2p + ort session）
│   └── ...
```

### 各模块职责

| 模块 | 职责 | 依赖 |
|---|---|---|
| `g2p::G2pProvider` | 文本→音素序列 | 无外部依赖 |
| `g2p::EspeakG2p` | 调用 espeak-ng CLI/库，传入 lang 参数 | espeak-ng |
| `g2p::PinyinG2p` | 中文回退：汉字→拼音→IPA | 内嵌字典 |
| `g2p::PassthroughG2p` | 英文/无需 G2P 的模型 | 无 |
| `g2p::G2pRouter` | 自动选择合适的 G2pProvider | 各 Provider |
| `inference::tts` | ONNX 推理 + G2P 集成 | ort, g2p |
| `lib.rs` (Tauri command) | 前端 IPC 桥接 | tts, g2p |

---

## 5. 扩展指南

### 新增 TTS 模型接入

1. 在 `REGISTRY`（`model_manager.rs`）添加模型元数据，设置 `pipeline_type: Direct` 或 `PipelineType::Phoneme`。
2. 如果是 Direct Pipeline：前端 tokenizer 直接 tokenize，无需 G2P。
3. 如果是 Phoneme Pipeline：`espeak-ng` 自动按 `lang` 参数产出 IPA；如需特殊映射，实现新的 `G2pProvider`。
4. 实现 `InferenceEngine` trait（`load`/`infer`/`unload`）。
5. 在 `TtsPanel.tsx` 的语言下拉中，语言列表来自 `rust_list_tts_voices`（扫描 `voices/` 目录按前缀分组），自动适配新模型。

### 新增语言支持

1. `espeak-ng` 已内置 ~80 种语言，传入对应 `lang` 即可。
2. 如果目标语言 `espeak-ng` 不支持：实现新的 `G2pProvider`（如 `PinyinG2p` 覆盖中文回退）。
3. 在 `G2pRouter` 中注册新 Provider，优先级高于回退。

---

## 6. 状态管理模型

### 当前实现

所有 TTS 操作（模型加载 / 语言切换 / 合成）走统一的状态链路：

```
UI 调用 ──► Store Action（乐观 loading）──► Rust Command ──► 结果回写 Store ──► UI 渲染
                │
Rust 事件 ──► 同一 Action（对账兜底）
```

**单一真源**：`useAppStore.getState()` 是唯一状态写入入口，所有组件订阅后自动重渲染。

**关键约束**：
- UI 不直接调 `invoke`，统一通过 `lib/modelLoader.ts` 或 `lib/tauri.ts` 封装。
- 语言切换走 `rustSetTtsLanguage`（轻量换 embedding，不重载 311MB 模型）。
- 模型加载走 `loadAsrModel` / `loadTtsModel`（统一入口，乐观 `loading` → `ready/error`）。

---

## 7. 模型落盘与快照同步

使用 `hf-hub 1.0` 的 `snapshot_download` 整仓同步，确保多文件模型不漏：

- `modelRoot/Kokoro-82M/` 下必须包含：`onnx/model.onnx` + `tokenizer.json` + `voices/*.bin`（或 `*.pt`）
- `voices/` 目录按前缀分组映射语言：`af_*→en`, `zf_*→zh`, `jf_*→ja`
- 扫描由 `rust_list_tts_voices` 完成，前端下拉框自动适配
- 未扫到任何 voices 时回落 `["zh","en"]`，保证下拉可用

---

## 8. 已知限制与后续规划

| 项目 | 现状 | 规划 |
|---|---|---|
| espeak-ng 集成 | 尚未绑定 Rust crate，使用回退 G2P | 引入 `espeak-ng-sys` crate 或 CLI 调用 |
| 中文 G2P | 使用内置拼音→IPA 字典回退 | espeak-ng 中文支持后切到统一管道 |
| Direct Pipeline | 尚未实现（Qwen-TTS 等） | Phase 3 接入 HuggingFace tokenizers crate |
| ASR GGUF 推理 | `asr.rs` 占位，诚实报错 | 接入 `llama-cpp-2` crate |
| Edge-TTS | 未接入 | Phase 4 作为网络 fallback |
| 速度控制 | `speed` 张量固定 `1.0` | 从 `tts.rate` 传入，支持 0.5~2.0x |

---

## 9. 参考资料

- [ort crate (pykeio)](https://github.com/pykeio/ort) — ONNX Runtime Rust 绑定
- [espeak-ng](https://github.com/espeak-ng/espeak-ng) — 开源语音合成 / G2P 引擎
- [Kokoro-82M-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-ONNX) — 模型来源
- [技术重构文档](./技术重构文档.md) — Python→Rust 迁移全景
