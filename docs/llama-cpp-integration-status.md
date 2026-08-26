# llama-cpp-2 集成状态报告

## 当前状态：❌ 未接入（占位符）

`llama-cpp-2 = "0.1"` 已在 `Cargo.toml` 中声明依赖，编译也通过了，但**项目中没有任何 Rust 源码 `use` 它**，引擎实现全部是诚实的占位符，直接返回 "not implemented" 错误。

---

## 现有代码结构

```
src-tauri/src/inference/
├── mod.rs          # 模块声明
├── engine.rs       # InferenceEngine trait 定义（抽象层）
├── asr.rs          # AsrEngine —— llama-cpp-2 占位实现
├── commands.rs     # Tauri 命令桥接（load_asr_model / transcribe_file_rust）
├── errors.rs       # 错误类型
└── tests.rs        # 测试（断言 load 返回错误）
```

---

## 当前占位实现详情

### `asr.rs` — AsrEngine

```rust
pub struct AsrEngine {
    state: AsrState,  // 只有状态，没有实际引擎实例
}

impl InferenceEngine for AsrEngine {
    fn load(&mut self, _model_path: &Path, _device: Device) -> InferenceResult<()> {
        // ❌ 直接返回错误，不加载任何模型
        self.state = AsrState::Error("ASR engine not implemented yet: llama-cpp-2 (GGUF) integration pending".into());
        Err(InferenceError::LoadFailed(err))
    }

    fn is_loaded(&self) -> bool { false }  // 永远返回 false
    fn infer(&mut self, _input: &InferInput) -> InferenceResult<InferOutput> {
        Err(InferenceError::NotInitialized)  // 永远返回未初始化
    }
}
```

### `lib.rs` — rust_load_asr_model 命令

```rust
// GGUF → llama-cpp-2 引擎（尚未接入）：诚实报错，不假装加载成功
model_manager::ModelFormat::Gguf => {
    let msg = "ASR GGUF engine not implemented yet".to_string();
    // emit model_error 事件
}
```

### `inference/tests.rs` — 测试断言

```rust
let result = engine.load(&model_path, Device::Cpu);
// ASR 引擎尚未接入 llama-cpp-2：当前必须如实返回错误，而非假装加载成功
assert!(result.is_err(), "ASR engine should report not-implemented");
assert!(!engine.is_loaded());
```

---

## 需要接入的 llama-cpp-2 API

根据 `asr.rs` 注释中的接入规划：

```
接入规划：把 llama-cpp-2 的 `LlamaModel` / `LlamaContext` / `MtmdContext`
作为本结构体的字段（`Box` 持有，`Drop` 自动释放），不需要裸指针与 `unsafe`。
```

llama-cpp-2 crate（v0.1）提供的核心类型：

| 类型 | 用途 | 对应模型 |
|------|------|----------|
| `LlamaModel` | 加载 GGUF 模型文件 | Qwen3-ASR-0.6B-Q8_0.gguf |
| `LlamaContext` | 推理上下文（KV cache 管理） | 与模型绑定 |
| `LlamaChatMessage` | 对话消息格式 | ASR 需构造 prompt |
| `MtmdContext`（多模态） | 音频 embedding（如果有） | Qwen3-ASR 需要处理音频输入 |

关键 API：
- `LlamaModel::load(path)` → 加载 GGUF 文件
- `LlamaModel::new_context(params)` → 创建推理上下文
- `context.decode(input)` → 执行推理
- `model.embedding(text)` → 获取文本 embedding

---

## Qwen3-ASR GGUF 模型特性

`model_manager.rs` 中注册的模型：

```rust
ModelInfo {
    name: "Qwen3-ASR-0.6B",
    kind: "asr",
    format: ModelFormat::Gguf,
    repo: "ggml-org/Qwen3-ASR-0.6B-GGUF",
    size_gb: 1.0,
}
```

Qwen3-ASR 是**端到端语音识别模型**，输入音频 → 直接输出文本。使用 llama-cpp-2 加载时需要：
1. 加载 GGUF 模型
2. 将音频 token 化（可能是 mel spectrogram 或 audio tokens）
3. 构造 prompt（如 `<|audio|>请识别以下语音：`）
4. 执行推理，提取文本输出

---

## 接入所需的工作

### 最小可行接入（P0）

1. **AsrEngine 结构体添加字段**：
   ```rust
   pub struct AsrEngine {
       state: AsrState,
       model: Option<llama_cpp_2::LlamaModel>,
       context: Option<llama_cpp_2::LlamaContext>,
       device: Device,
       model_name: Option<String>,
   }
   ```

2. **实现 `load()` 方法**：
   ```rust
   fn load(&mut self, model_path: &Path, device: Device) -> InferenceResult<()> {
       self.state = AsrState::Loading;
       let model = LlamaModel::load(model_path, ...)?;
       let ctx = model.new_context(LlamaContextParams::default())?;
       self.model = Some(model);
       self.context = Some(ctx);
       self.state = AsrState::Ready;
       Ok(())
   }
   ```

3. **实现 `infer()` 方法**：
   - 解码音频文件为 PCM（已有 `audio::decode_audio`）
   - 构造 prompt（ASR prompt template）
   - 调用 `context.decode()` 推理
   - 提取输出文本

4. **音频 token 化**：
   - Qwen3-ASR 使用 `<|audio|>` 标记
   - 需要将音频转为模型可接受的格式（可能是 mel spectrogram）
   - 或使用 llama.cpp 的 audio features

5. **移除占位断言**：
   - `tests.rs` 中改为断言加载成功

### 后续优化（P1）

- GPU 加速（CUDA device selection）
- 流式识别（partial transcript）
- 显存管理（模型卸载/换入）

---

## 阻塞问题

### 1. Qwen3-ASR GGUF 音频 token 化方式

llama-cpp-2 主要设计用于文本 LLM 推理，音频 ASR 需要额外的音频 token 化逻辑。可能的方式：
- llama.cpp 内置的 multimodal 支持（`mtmd` API）
- 自定义 audio preprocessing（mel spectrogram → token）
- 参考 ggml-org/Qwen3-ASR-0.6B-GGUF 仓库的推理代码

### 2. llama-cpp-2 crate 版本限制

当前使用 `llama-cpp-2 = "0.1"`（较旧版本），可能缺少：
- multimodal/audio API
- 最新的 CUDA/rocm 后端优化
- 需要评估是否升级到最新版

### 3. 编译环境

llama-cpp-sys-2 需要编译 llama.cpp C++ 代码，可能需要：
- CMake
- CUDA SDK（如需 GPU）
- 正确的 toolchain 配置

---

## 当前行为（用户可见）

1. 用户在 ModelsPanel 下载 `Qwen3-ASR-0.6B`（~1GB GGUF 文件）
2. 用户点击"加载"按钮
3. `loadAsrModel()` → invoke `rust_load_asr_model`
4. Rust 端：`model_manager` 找到 `.gguf` 文件
5. 命中 `ModelFormat::Gguf` 分支 → 直接返回错误
6. 前端收到 `model_error` 事件 → 显示错误状态
7. 日志：`ASR GGUF engine not implemented yet`

---

## 参考：同类项目的 llama-cpp ASR 实现

可参考以下项目了解 llama.cpp 处理音频 ASR 的方式：
- `ggml-org/whisper.cpp` — llama.cpp 生态的语音识别实现
- `ggml-org/llama.cpp` — 主仓库的 multimodal 支持
- `QwenLM/Qwen3-ASR` — 官方推理代码（参考 prompt 格式）
