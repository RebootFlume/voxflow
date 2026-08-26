# TTS 引擎架构说明（端到端 / E2E）

> 本文档描述 VoxFlow TTS 子系统的端到端（E2E）架构：纯文本输入 → 模型推理 → 波形输出。
> 不再包含音素（G2P）、语速调节、时长预测或重采样/拉伸后处理。

---

## 1. 设计目标

- **可插拔引擎**：不同 TTS 模型通过统一 `TtsEngine` trait 接入，前端无感知切换。
- **端到端直通**：管道即「纯文本 → tokenizer → ONNX 推理 → i16 PCM → WAV」，中间无音素标注、语速/时长/重采样。
- **配置驱动**：模型差异全部收敛在 `ModelManifest`（manifest.json）中，新模型无需改动 Rust 代码。
- **状态健壮**：所有加载/合成操作走统一 Action → Store 单一真源，UI 不依赖脆弱的事件猜测。

---

## 2. 核心架构：E2E 流水线

```
原始文本 ──► TextTokenizer（纯文本 → token ids）──► ONNX 推理 ──► f32 → i16 ──► WAV 文件
                   │                                         │
                   └─ tokenizer.json vocab 加载              └─ style (voice embedding) + manifest 配置
```

### 管道步骤

| 步骤 | 组件 | 说明 |
|---|---|---|
| 1. 文本分词 | `TextTokenizer` | 纯文本 → token ids（整词优先 + 逐字符兜底） |
| 2. 风格输入 | `style` (voice embedding) | 按语言切换的 256 维向量 |
| 3. ONNX 推理 | `GenericOnnxEngine` | 按 manifest 组装输入张量 → 波形输出 |
| 4. PCM 转换 | `service::infer` | f32 → i16（24kHz mono），无重采样/拉伸 |
| 5. WAV 写入 | `hound` crate | 写入 24kHz i16 WAV 文件 |

### 与旧架构的差异

| 旧架构（已移除） | 新架构 |
|---|---|
| 双轨管道（Direct / Phoneme） | 单轨 E2E 管道 |
| `PipelineType` 枚举 | 已移除，仅 E2E |
| `PhonemizerRouter` + espeak-ng + 拼音回退 | `TextTokenizer`（vocab 直通） |
| `speed` 张量（0.5–2.0x） | 已移除，无语速调节 |
| `rate` 参数（IPC + trait） | 已移除 |
| `duration` 字段（预测/结果） | 已移除 |
| `G2pFailed` 错误 | 已移除，用 `InvalidInput` 替代 |
| `middleware/` 模块（espeak/pinyin/passthrough/vocab_mapper/direct_tokenizer） | 已删除，替换为 `tokenizer.rs` |

---

## 3. 模块职责划分

```
src-tauri/src/tts/
├── mod.rs              # 模块声明与导出
├── tokenizer.rs        # E2E 文本分词器（纯文本 → token ids）
├── config.rs           # ModelManifest（模型元数据，JSON 驱动）
├── engine/
│   └── onnx.rs         # GenericOnnxEngine（统一 ONNX 推理，按 manifest 组装张量）
├── traits.rs           # TtsEngine 抽象 trait + TtsResult 类型
├── service.rs          # TtsService（统一调度 Service，状态机）
└── commands.rs         # Tauri 命令桥接（前端 IPC）
```

| 模块 | 职责 | 依赖 |
|---|---|---|
| `tokenizer` | 纯文本 → token ids（vocab 直通，无 G2P） | serde_json |
| `config` | manifest.json 解析，自动探测模型布局 | serde |
| `engine/onnx` | ONNX session 执行，按 manifest 组装输入张量 | ort |
| `traits` | `TtsEngine` trait：load / infer / unload / set_language | — |
| `service` | 模型加载、tokenizer 装载、voice 管理、推理调度 | engine, config, tokenizer |
| `commands` | `rust_load_tts_model` / `rust_synthesize` / `rust_set_tts_language` / `rust_list_tts_voices` | service, AppState |

---

## 4. TextTokenizer（E2E 分词）

替代旧的 `PhonemizerRouter`（espeak-ng + 拼音 + passthrough），实现纯文本分词：

```rust
pub struct TextTokenizer {
    vocab: HashMap<String, u32>,  // token → id（来自 tokenizer.json）
}

impl TextTokenizer {
    /// 从 tokenizer.json 的 model.vocab 装载
    pub fn load_tokenizer(&mut self, model_root: &Path, tokenizer_file: &str);

    /// 纯文本 → token ids：整词优先 + 逐字符小写兜底，未命中跳过
    pub fn encode(&self, text: &str) -> Vec<i64>;
}
```

- 无需 espeak-ng，无音素词典，无拼音表
- 装载模型自带的 `tokenizer.json` 的 `model.vocab`
- 整词精确匹配优先，字符级兜底

---

## 5. ModelManifest（配置驱动）

```json
{
    "id": "Kokoro-82M",
    "model_file": "onnx/model.onnx",
    "tokenizer_file": "tokenizer.json",
    "sample_rate": 24000,
    "inputs": {
        "tokens": { "name": "input_ids", "dtype": "i64" },
        "style": { "name": "style", "dtype": "f32" }
    },
    "outputs": ["waveform", "logits", "audio_out", "audio"],
    "voices": { "en": "voices/af.bin", "zh": "voices/zf_xiaobei.bin" }
}
```

- **`inputs.tokens`**：E2E 文本 token 张量（必填）
- **`inputs.style`**：voice embedding（可选，有则绑定）
- **`outputs`**：候选输出节点名，按序取第一个存在者
- **`voices`**：语言 → voice embedding 文件（相对模型目录）

---

## 6. 状态管理模型

```
UI 调用 ──► Store Action（乐观 loading）──► Rust Command ──► 结果回写 Store ──► UI 渲染
                │
Rust 事件 ──► 同一 Action（对账兜底）
```

**单一真源**：`useAppStore.getState()` 是唯一状态写入入口。

**关键约束**：
- UI 不直接调 `invoke`，统一通过 `lib/modelLoader.ts` / `lib/tauri.ts` 封装
- 语言切换走 `rustSetTtsLanguage`（轻量换 voice embedding，不重载模型）
- 模型加载走 `loadTtsModel`（统一入口，乐观 `loading` → `ready/error`）

---

## 7. IPC 命令

| 命令 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `rust_load_tts_model` | model_path, device | `{ status, model, device }` | 加载 TTS 模型 |
| `rust_synthesize` | text, voice, export_dir | `{ text, voice, saved_path, size }` | 端到端合成 WAV |
| `rust_set_tts_language` | language | `{ language }` | 切换 voice embedding |
| `rust_list_tts_voices` | — | `{ languages, voices_by_lang, default_lang }` | 扫描可用音色 |
| `rust_test_tts_model` | — | `{ status, model, device }` | 测试模型加载 |

**关键移除**：`rust_synthesize` 不再接受 `rate`（语速）参数，不再返回 `duration`。

---

## 8. 模型落盘与快照同步

使用 `hf-hub 1.0` 的 `snapshot_download` 整仓同步：

- `modelRoot/Kokoro-82M/` 下：`onnx/model.onnx` + `tokenizer.json` + `voices/*.bin`
- `voices/` 目录按前缀分组映射语言：`zf_*→en`, `zm_*→zh`, `jf_*→ja`
- 扫描由 `rust_list_tts_voices` 完成，前端下拉框自动适配

---

## 9. 扩展指南

### 新增 TTS 模型接入

1. 在 `REGISTRY`（`model_manager.rs`）添加模型元数据（format: Onnx）
2. 模型目录放 `manifest.json`（按 §5 格式）或使用自动探测
3. 模型需自带 `tokenizer.json`（`model.vocab`）和 `voices/*.bin`
4. `TtsEngine` trait 已封装，新模型只需 manifest 配置正确即可

### 新增语言支持

1. 在 `voices/` 目录添加对应语言的 voice embedding 文件
2. `scan_voices` 自动按前缀识别语言（`zf_`→zh, `jf_`→ja, 其他→en）
3. 前端语言下拉由 `rust_list_tts_voices` 动态生成
