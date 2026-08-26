# TTS 引擎重构待办列表

> 供新会话直接接手，含完整上下文与执行顺序。

---

## 📌 前置上下文

### 项目概况
- **VoxFlow**：本地 Qwen3-ASR + Kokoro TTS 语音工具，Tauri 2 + Rust + React
- 技术栈：`ort 2.0-rc.13 + directml`（ONNX Runtime）、`hf-hub 1.0`（模型下载）、`hound 3.5`（音频）、`parking_lot` + `once_cell`（并发/状态）
- Rust edition 2021，`cargo check --lib` 零错误

### 当前 TTS 状态
- ✅ 标准模型 `onnx-community/Kokoro-82M-ONNX` 能加载、英文能合成（42000 samples @24kHz）
- ✅ 语言下拉已接通（`rustSetTtsLanguage` 轻量切换 embedding，`.pt` ZIP + `.bin` 裸 f32 兼容）
- ✅ QDQ 量化模型 `model_q8f16` 在 `ort 2.0-rc.13` 上会段错误 → `find_main_model_file` 已优先选标准 `model.onnx`
- ❌ 中文不能合成：`text_to_phonemes` 直接查 vocab，中文汉字不在 vocab → 报错 "phoneme encoding is empty"
- ❌ 现有代码在 `src-tauri/src/inference/tts.rs`（单文件，结构不符合新架构）

### 关键设计文档
- `TTS引擎架构与G2P管道技术说明.md`（项目根目录）
- `技术重构文档.md`（Python→Rust 迁移全景）

---

## 📋 待办清单（按执行顺序）

### Phase 1：G2P 工具模块（独立、可复用）

#### 1.1 创建 `src-tauri/src/tts/phonemizer/mod.rs`
- [ ] 定义 `Phonemizer` trait
```rust
pub trait Phonemizer: Send + Sync {
    fn name(&self) -> &str;
    fn can_handle(&self, text: &str) -> bool;
    fn phonemize(&self, text: &str) -> Vec<String>;
}
```
- [ ] 实现 `PhonemizerRouter`：`new()` → `register()` → `phonemize(text)` → `to_token_ids(text, vocab)`
- [ ] `segment_text(text)` 辅助函数：按 Unicode 范围分段（en/zh/ja/punct）

#### 1.2 创建 `src-tauri/src/tts/phonemizer/passthrough.rs`
- [ ] `PassthroughG2p`：英文直通，字符小写后逐字查 vocab
- [ ] `can_handle`：全 ASCII 字母数字

#### 1.3 创建 `src-tauri/src/tts/phonemizer/espeak.rs`（标准 IPA 路径）
- [ ] `EspeakG2p`：检测系统 espeak-ng 是否可用（`which espeak-ng` 或 `std::process::Command`）
- [ ] `can_handle`：espeak-ng 可用时全部语言都能处理
- [ ] `phonemize`：调 `espeak-ng -v {lang} --phonout -` 从 stdin 读 IPA 输出
- [ ] lang 代码映射表：`zh→cmn`、`en→en`、`ja→jap` 等
- [ ] 不可用时返回 false，路由到回退

#### 1.4 创建 `src-tauri/src/tts/phonemizer/pinyin.rs`（中文回退）
- [ ] 内嵌拼音字典：`HashMap<char, &'static str>`，覆盖 ~3500 常用汉字
- [ ] 拼音→IPA 映射：`HashMap<&str, Vec<&str>>`，覆盖所有标准普通话音节约 410 条
- [ ] `PinyinG2p`：`can_handle` 检测 `[\u{4e00}-\u{9fff}]`
- [ ] `phonemize`：逐字查拼音表 → IPA → 输出 token 符号序列

#### 1.5 `phonemizer/mod.rs` 补充
- [ ] `PhonemizerRouter::new()` 默认注册顺序：`[espeak, pinyin, passthrough]`
- [ ] 选择逻辑：第一个 `can_handle` 为 true 的 provider

---

### Phase 2：TTS 引擎迁移（从 inference/ → tts/）

#### 2.1 创建 `src-tauri/src/tts/mod.rs`
- [ ] 模块声明：`pub mod engine; pub mod kokoro; pub mod phonemizer; pub mod commands;`
- [ ] 类型导出：`pub use kokoro::KokoroEngine;` `pub use engine::TtsEngine as TtsTrait;`

#### 2.2 创建 `src-tauri/src/tts/engine.rs`
- [ ] 定义统一 trait：
```rust
pub trait TtsEngine: Send + Sync {
    fn name(&self) -> &str;
    fn load(&mut self, model_path: &Path, device: &str) -> Result<()>;
    fn unload(&mut self) -> Result<()>;
    fn is_loaded(&self) -> bool;
    fn set_language(&mut self, language: &str) -> Result<()>;
    fn infer(&mut self, text: &str, voice: &str, rate: f64) -> Result<Vec<i16>>;
}
```

#### 2.3 创建 `src-tauri/src/tts/kokoro.rs`
- [ ] `KokoroEngine` struct：持有 `ort::Session` + `PhonemizerRouter` + `phoneme_to_id` + `voice_embedding`
- [ ] 从现有 `inference/tts.rs` 迁移 `do_load`、`load_voice_embedding`、`set_language_voice` 逻辑
- [ ] `infer` 方法内用 `router.to_token_ids(text, &vocab)` 替代原来的 `text_to_phonemes`
- [ ] 保持对 `.pt` ZIP（`zf_*.pt`）和 `.bin` 裸 f32 两种 voice 文件格式的兼容

#### 2.4 创建 `src-tauri/src/tts/commands.rs`
- [ ] 从 `lib.rs` 抽出：`rust_load_tts_model`、`rust_synthesize`、`rust_set_tts_language`、`rust_list_tts_voices`
- [ ] 使用 `app_state.rs` 的全局引擎引用

---

### Phase 3：统一错误处理

#### 3.1 创建 `src-tauri/src/errors.rs`
- [ ] 定义 `AppError` 枚举：
```rust
pub enum AppError {
    ModelNotFound(String),
    LoadFailed(String),
    InferenceFailed(String),
    G2pFailed(String),
    NotInitialized,
    InvalidInput(String),
}
impl std::fmt::Display for AppError { ... }  // 英文，Rust 端不做 i18n
impl std::error::Error for AppError {}
impl Serialize for AppError { ... }  // 给 Tauri command 用
```
- [ ] 替换 `inference::errors::InferenceError`（或让其 alias 到 AppError）

---

### Phase 4：全局状态与 lib.rs 清理

#### 4.1 创建 `src-tauri/src/app_state.rs`
- [ ] 替代 `lib.rs` 顶部的 `static ASR_ENGINE / TTS_ENGINE` 全局变量
- [ ] 改为 `tauri::Builder::manage()` 注入 + `State<T>` 命令参数

#### 4.2 清理 `lib.rs`
- [ ] 把 TTS 相关 command 移到 `tts/commands.rs`，lib.rs 只做 `generate_handler!` 注册
- [ ] 把 `is_model_in_use` 的 ASR/TTS 判定改用 `app_state` + `modelState.resolveModelKind` 对应逻辑
- [ ] 删除已废弃的 Python sidecar 残留（`send_to_sidecar` 已删，`sidecar::SharedSidecar` 已删）

#### 4.3 废弃 `src-tauri/src/inference/tts.rs`
- [ ] 迁移完成后加 `#[deprecated]` 注释
- [ ] 确认所有引用迁到 `tts::kokoro` 后删除

---

### Phase 5：测试与验证

#### 5.1 单元测试
- [ ] `phonemizer/passthrough.rs`：英文 "Hello world" → token_ids 非空
- [ ] `phonemizer/pinyin.rs`：中文 "你好" → phonemes 非空
- [ ] `kokoro.rs`：`test_tts_model_load` + `test_tts_inference_pipeline`（现有 `#[ignore]` 用例迁移）
- [ ] `persistence.rs`：`config.json` 读写 + `io.exportDir` 迁移

#### 5.2 集成验证
- [ ] `cargo test --lib` 全绿（12 passed + 新增用例）
- [ ] `tsc --noEmit` 零错误
- [ ] `npm run build` 通过
- [ ] `tauri dev` 启动：TTS → 模型与设备 → `ready`
- [ ] 中文短句合成：`你好世界` → 不报错（或明确报中文 G2P 未就绪）
- [ ] 英文合成：`Hello world` → 正常出声
- [ ] 语言切换：下拉选 Chinese/English/Japanese → 日志 `[tts] switch language` 成功

---

### Phase 6（后续）：espeak-ng 完整接入

- [ ] 引入 `espeak-ng-sys` crate 或 CLI wrapper
- [ ] 中文合成验证：`你好世界` → IPA → token_ids → 正常音频
- [ ] 文档更新 `TTS引擎架构与G2P管道技术说明.md`

---

## ⚠️ 关键踩坑记录

| 问题 | 根因 | 修复 |
|---|---|---|
| TTS 加载一直"loading" | `main.tsx` 调空分支 `set_model`，没调 Rust 加载 | 改为 `loadTtsModel` |
| 选语言不生效 | 前端改 store，没传到 Rust | 新增 `rustSetTtsLanguage` → `TtsEngine::set_language_voice` |
| 中文 0.5s 杂音 | `text_to_phonemes` 直接查 vocab，中文全跳空 → `[0,0]` | 报错提示用英文，中文走 Phoneme Pipeline |
| `ort rc.13` 加载 QDQ 段错误 | `commit_from_file` + QDQ 量化模型不兼容 | `find_main_model_file` 优先选标准 `model.onnx` |
| `tts.rs` 编译 duplicate definition | 多次 edit 叠加，backup 本身已坏 | 整体重写一次干净结构 |
| `model file not found` | `modelRoot` 指向 AppData（PyTorch 权重），模型在 workspace | 加 workspace 回退路径 |
| TTS 生成 0.5s 无关音频 | 中文无 phoneme → 只有边界 `$` → 4 个 token | `has_content` 校验 + 报错 |

---

## 📁 你操作前先确认的文件

| 文件 | 作用 | 是否要改 |
|---|---|---|
| `src-tauri/src/inference/tts.rs` | 当前 TTS 实现（待迁移） | 迁移后废弃 |
| `src-tauri/src/lib.rs` | Tauri command 注册 | TTS command 抽走 |
| `src-tauri/src/model_manager.rs` | 模型管理 | 小改（删 dead code） |
| `src/lib/modelLoader.ts` | 前端模型加载封装 | 不改（已是单一入口） |
| `src/stores/app.ts` | 全局状态 | 不改（已是单一真源） |
| `src/modules/tts/TtsPanel.tsx` | TTS 面板 UI | 不改（已接通语言切换） |
| `models/Kokoro-82M/` | 标准模型（已下载） | 不动 |
| `config.json` | 用户配置（已迁移 io.exportDir） | 不动 |

---

## 🔧 开工建议

1. **先跑 `cargo check --lib` 确认当前基线**（应零错误）
2. **从 Phase 1.1 开始**（`phonemizer/mod.rs`），这是独立模块，不影响现有代码
3. **Phase 1 完成后做 Phase 2**（引擎迁移），此时可以删 `inference/tts.rs`
4. **每个 Phase 完成后跑 `cargo check --lib` + `cargo test --lib`**
5. **`model.onnx` 已就位（311MB）**，测试时用 `--ignored` 跑真实模型用例
