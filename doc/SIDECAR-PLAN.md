# Python Sidecar 方案

> 本文档定义从"纯 Rust 推理"回退到"Rust 系统级 + Python 推理 sidecar"的架构。

---

## 1. 核心思路

```
┌─────────────────── Tauri 2 ──────────────────────────┐
│                                                       │
│  Rust 主进程              Python sidecar 子进程        │
│  ─────────────            ──────────────────────       │
│  • 全局热键                • TTS 推理（Kokoro PyTorch） │
│  • 托盘/剪贴板上屏         • ASR 推理（SenseVoice 等）  │
│  • 音频采集（cpal）        • GPU 检测（nvidia-smi）     │
│  • 模型下载（hf-hub）     • 音频解码（soundfile）       │
│  • 数据持久化                                           │
│                                                       │
│           ◄── JSON lines over stdin/stdout ──►         │
└───────────────────────────────────────────────────────┘
```

**前端完全不变。** Tauri command 名字不变，只是 Rust 侧把推理请求转发给 Python。

---

## 2. IPC 协议

沿用原 CapsWriter 风格：**JSON lines over stdin/stdout**。

### Rust → Python（请求）

```json
{"action": "tts_load", "model_path": "/path/to/Kokoro-82M", "device": "cuda"}
{"action": "tts_infer", "text": "Hello world", "voice": "af", "lang": "en", "speed": 1.0}
{"action": "tts_set_language", "lang": "zh"}
{"action": "asr_load", "model_path": "/path/to/model", "device": "cuda"}
{"action": "asr_transcribe", "file_path": "/path/to/audio.wav"}
{"action": "asr_transcribe_chunk", "samples": [...], "sample_rate": 16000}
{"action": "gpu_info"}
{"action": "shutdown"}
```

### Python → Rust（响应 / 事件）

```json
{"status": "ok", "request_id": "...", "data": {...}}
{"status": "error", "request_id": "...", "msg": "model not found"}
{"status": "model_ready", "model": "Kokoro-82M", "device": "cuda"}
{"status": "progress", "model": "Kokoro-82M", "percent": 45}
{"event": "asr_result", "text": "hello world", "is_final": true}
{"event": "audio_level", "level": 0.3}
```

### 事件推送（Python → Rust，异步）

Python 可随时推事件（识别中间结果、音量等），Rust 通过 `app.emit("sidecar://event", ...)` 转发给前端。协议与当前 `sidecar://event` 完全兼容，前端零改动。

---

## 3. Rust 侧保留的命令

| 命令 | 保留原因 |
|---|---|
| `send_to_sidecar_safe` | 改为转发到 Python（推理 action）或 Rust 原生处理（bootstrap/download 等） |
| `set_hotkey` | 系统级，rdev + global-shortcut |
| `get_gpu_info` | 转发到 Python（nvidia-smi） |
| `decode_audio_file` | 转发到 Python（soundfile）或保留 Rust（hound） |
| `rust_list_audio_devices` | cpal 原生 |
| `hf_download_*` | hf-hub Rust crate，下载保持原生 |
| `read/write_data_file` | 持久化，Rust 原生 |
| `rust_load_tts_model` → | 转发 `{"action":"tts_load", ...}` |
| `rust_synthesize` → | 转发 `{"action":"tts_infer", ...}` |
| `rust_set_tts_language` → | 转发 `{"action":"tts_set_language", ...}` |
| `rust_list_tts_voices` → | 转发或 Rust 本地扫描 voices 目录 |
| `rust_load_asr_model` → | 转发 `{"action":"asr_load", ...}` |
| `rust_transcribe` → | 转发 `{"action":"asr_transcribe", ...}` |

**前端 invoke 接口不变，只是 Rust 侧把推理 action 路由到 Python。**

---

## 4. Python Sidecar 结构

```
python-backend/
├── main.py              # 入口：读 stdin → 分发 → 写 stdout
├── sidecar.py           # Sidecar 主循环（JSON lines 解析）
├── tts/
│   ├── __init__.py
│   ├── kokoro_engine.py # Kokoro TTS（KPipeline + KModel）
│   └── voices.py        # 音色列表扫描
├── asr/
│   ├── __init__.py
│   └── sensevoice.py    # SenseVoice / Paraformer / 其他 PyTorch ASR
├── audio/
│   ├── __init__.py
│   └── decode.py        # 音频解码（soundfile）
├── utils/
│   ├── __init__.py
│   └── gpu.py           # GPU 检测
├── requirements.txt     # 依赖清单
└── pyproject.toml       # 项目配置
```

### 依赖（精简）

```
torch>=2.0
kokoro>=0.8          # 或 hexgrad/Kokoro-82M（pip install kokoro）
soundfile
numpy
```

**不需要**：onnxruntime、transformers（除非 ASR 需要）、espeak-ng（kokoro 包自带 G2P）

---

## 5. Kokoro TTS（PyTorch 版）

```python
from kokoro import KPipeline, KModel

# 一个 KModel 实例跨语言共享
model = KModel(repo_id='hexgrad/Kokoro-82M').to(device).eval()

# 每种语言一个 KPipeline（共享 model）
us_pipeline = KPipeline(lang_code='a', model=model)  # 美式英语
jp_pipeline = KPipeline(lang_code='j', model=model)  # 日语
zh_pipeline = KPipeline(lang_code='z', model=model)  # 中文

# 合成
for gs, ps, audio in us_pipeline("Hello world", voice='af_heart'):
    # audio: numpy array, 24kHz
    ...
```

**优势**：
- 正确的 G2P（misaki/neural，不是 espeak 字母直通）
- 多语言原生支持（a/b/e/f/h/i/j/p/z）
- 完整音色库（af_*, am_*, bf_*, bm_*, jf_*, zf_* 等）
- 配置正确时加载 <1 秒

---

## 6. 模型下载

保持 Rust 原生 hf-hub 下载。下载到 `AppData/com.voxflow.app/models/`。

PyTorch 版 Kokoro 也可以通过 `KPipeline(repo_id='hexgrad/Kokoro-82M')` 自动下载（HuggingFace 缓存），但最好统一走 Rust 下载管理器，保持前端进度条一致。

---

## 7. Rust 侧改造要点

### 7.1 `send_to_sidecar_safe` 改造

```rust
// 当前：所有 action 在 Rust 原生处理
// 改后：推理 action 转发到 Python
fn send_to_sidecar_safe(...) {
    match action {
        // ── Rust 原生 ──
        "bootstrap" | "set_model_root" | "set_mirror" | "set_proxy"
        | "list_models" | "download_model" | "cancel_download" | "delete_model" => {
            // 保持不变
        }
        // ── 转发到 Python ──
        "tts_load" | "tts_infer" | "tts_set_language" | "tts_list_voices"
        | "asr_load" | "asr_transcribe" | "gpu_info" => {
            sidecar.send(payload)  // 写到 Python stdin
            // 等待 Python 响应 或 异步推送事件
        }
    }
}
```

### 7.2 Python 子进程管理

```rust
// 启动：app 启动时 spawn python-backend/main.py
// 通信：tokio::process::Child（stdin/stdout 异步读写）
// 关闭：app 退出时发 {"action":"shutdown"} 等待退出
```

---

## 8. ASR 方案（待定）

| 方案 | 模型 | 依赖 | 说明 |
|---|---|---|---|
| A | SenseVoice-Small | funasr + torch | 中文识别优秀，1.5B |
| B | Paraformer | funasr + torch | 非自回归，毫秒级 |
| C | Qwen3-ASR（GGUF） | llama-cpp-python | 0.6B 轻量，但需 llama-cpp binding |
| D | 先不做 ASR | — | Tauri 骨架保留，Python 侧后续接入 |

---

## 9. 执行顺序

1. **创建 `python-backend/`**，搭 sidecar 主循环 + IPC 协议
2. **接入 Kokoro TTS**（PyTorch 版），验证合成质量
3. **Rust 侧改造**：推理命令转发到 Python
4. **前端零改动**验证（TTS 合成能跑通）
5. **ASR 接入**（选方案后）
6. **打包**：PyInstaller / Nuitka 打包 Python sidecar 到 Tauri 安装包
