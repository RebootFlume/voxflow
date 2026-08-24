# Python Sidecar 方案

> 本文档定义从"纯 Rust 推理"回退到"Rust 系统级 + Python 全能 sidecar"的架构。

---

## 1. 核心思路

```
┌─────────────────── Tauri 2 ──────────────────────────────┐
│                                                           │
│  Rust 主进程                 Python sidecar 子进程          │
│  ─────────────               ──────────────────────        │
│  • 全局热键                   • TTS 推理（Kokoro PyTorch）  │
│  • 托盘/剪贴板上屏            • ASR 推理（待接入）           │
│  • 音频采集（cpal）           • 模型下载（huggingface_hub） │
│  • 数据持久化                 • GPU 检测（nvidia-smi）      │
│  • 事件转发给前端             • 音频解码（soundfile）        │
│                                                           │
│             ◄── JSON lines over stdin/stdout ──►           │
└───────────────────────────────────────────────────────────┘
```

**Rust 只做系统级**，其余全交给 Python。前端零改动。

---

## 2. IPC 协议

JSON lines over stdin/stdout。

### Rust → Python（请求）

```json
// 推理
{"action": "tts_load", "request_id": "r1", "model_path": "...", "device": "cuda"}
{"action": "tts_infer", "request_id": "r2", "text": "Hello", "voice": "af_heart", "lang": "a", "speed": 1.0}
{"action": "tts_set_language", "request_id": "r3", "lang": "a"}
{"action": "tts_list_voices", "request_id": "r4"}
{"action": "asr_load", "request_id": "r5", "model_path": "...", "device": "cuda"}
{"action": "asr_transcribe", "request_id": "r6", "file_path": "..."}

// 下载
{"action": "download_model", "request_id": "r7", "repo_id": "hexgrad/Kokoro-82M", "model_name": "Kokoro-82M"}
{"action": "cancel_download", "request_id": "r8", "model_name": "Kokoro-82M"}
{"action": "delete_model", "request_id": "r9", "model_name": "Kokoro-82M"}
{"action": "list_models", "request_id": "r10"}

// 系统
{"action": "gpu_info", "request_id": "r11"}
{"action": "decode_audio", "request_id": "r12", "file_path": "..."}
{"action": "bootstrap", "request_id": "r13", "model_root": "...", "mirror": "...", "proxy": "..."}
{"action": "shutdown"}
```

### Python → Rust（响应）

```json
{"request_id": "r1", "status": "ok", "data": {...}}
{"request_id": "r1", "status": "error", "msg": "model not found"}
```

### Python → Rust（异步事件，Rust 转发给前端）

```json
{"event": "model_ready", "model": "Kokoro-82M", "device": "cuda"}
{"event": "download_progress", "model": "Kokoro-82M", "percent": 45, "speed": "12.3 MB/s"}
{"event": "download_done", "model": "Kokoro-82M", "path": "/..."}
{"event": "asr_result", "text": "hello", "is_final": true}
{"event": "audio_level", "level": 0.3}
```

Rust 收到事件后 `app.emit("sidecar://event", ...)` 转发给前端。**前端事件协议完全不变。**

---

## 3. 职责分工

| 职责 | Rust | Python |
|---|---|---|
| 全局热键 | ✅ rdev + global-shortcut | |
| 托盘/剪贴板 | ✅ arboard + enigo | |
| 音频采集 | ✅ cpal | |
| 数据持久化 | ✅ app data dir | |
| 事件转发 | ✅ app.emit() | |
| TTS 推理 | | ✅ Kokoro KPipeline+KModel |
| ASR 推理 | | ✅ 待选型 |
| 模型下载 | | ✅ huggingface_hub |
| GPU 检测 | | ✅ nvidia-smi |
| 音频解码 | | ✅ soundfile |
| 模型目录扫描 | | ✅ os.listdir |

---

## 4. Python Sidecar 结构

```
python-backend/
├── main.py              # 入口：spawn sidecar
├── sidecar.py           # 主循环：读 stdin → 分发 → 写 stdout
├── tts/
│   ├── __init__.py
│   ├── kokoro_engine.py # Kokoro TTS（KPipeline + KModel）
│   └── voices.py        # 音色列表扫描
├── asr/
│   ├── __init__.py
│   └── engine.py        # ASR（待接入）
├── download/
│   ├── __init__.py
│   └── hf_download.py   # huggingface_hub 封装（下载/删除/状态）
├── audio/
│   ├── __init__.py
│   └── decode.py        # 音频解码（soundfile）
├── utils/
│   ├── __init__.py
│   └── gpu.py           # GPU 检测
├── requirements.txt
└── pyproject.toml
```

### 依赖

```
torch>=2.0
kokoro>=0.8              # TTS（pip install kokoro）
huggingface_hub>=0.20    # 模型下载（官方 HF 库）
soundfile                # 音频解码
numpy
```

---

## 5. 模型下载（huggingface_hub）

```python
from huggingface_hub import snapshot_download, hf_hub_download

# 整仓下载（Kokoro-82M 含模型+tokenizer+voices）
snapshot_download(
    repo_id="hexgrad/Kokoro-82M",
    local_dir=f"{model_root}/Kokoro-82M",
    local_dir_use_symlinks=False,
)

# 单文件下载
hf_hub_download(repo_id="hexgrad/Kokoro-82M", filename="voices/af_heart.pt")
```

进度回调 → 推送 `download_progress` 事件 → Rust 转发前端。

**比 Rust hf-hub 优势**：
- HuggingFace 官方维护，兼容性最好
- 原生支持 mirror（`HF_ENDPOINT`）、proxy（`HTTP_PROXY`）、token
- `snapshot_download` 自动断点续传
- 与 `kokoro` 包共享缓存（不重复下载）

---

## 6. Kokoro TTS（PyTorch）

```python
from kokoro import KPipeline, KModel

model = KModel(repo_id='hexgrad/Kokoro-82M').to(device).eval()

us_pipeline = KPipeline(lang_code='a', model=model)  # 美式英语
jp_pipeline = KPipeline(lang_code='j', model=model)  # 日语
zh_pipeline = KPipeline(lang_code='z', model=model)  # 中文

for gs, ps, audio in us_pipeline("Hello world", voice='af_heart'):
    # audio: numpy 24kHz
    save_wav(audio, output_path)
```

**优势**：正确 G2P、多语言、完整音色库、配置正确加载 <1 秒。

---

## 7. Rust 侧改造

### 7.1 保留的命令（直接 Rust 处理）

| 命令 | 原因 |
|---|---|
| `set_hotkey` | 系统级 |
| `rust_list_audio_devices` | cpal |
| `read/write_data_file` | 持久化 |

### 7.2 转发到 Python 的命令

| 前端调用 | 转发 action |
|---|---|
| `send_to_sidecar({action:"bootstrap"})` | `bootstrap` |
| `send_to_sidecar({action:"download_model"})` | `download_model` |
| `send_to_sidecar({action:"list_models"})` | `list_models` |
| `send_to_sidecar({action:"delete_model"})` | `delete_model` |
| `rust_load_tts_model(...)` | `tts_load` |
| `rust_synthesize(...)` | `tts_infer` |
| `rust_set_tts_language(...)` | `tts_set_language` |
| `rust_list_tts_voices()` | `tts_list_voices` |
| `rust_load_asr_model(...)` | `asr_load` |
| `rust_transcribe(...)` | `asr_transcribe` |
| `get_gpu_info()` | `gpu_info` |
| `decode_audio_file(...)` | `decode_audio` |

### 7.3 可删除的 Rust 模块

| 模块 | 原因 |
|---|---|
| `model_manager.rs` | 下载/扫描全部移到 Python |
| `tts/` 整个目录 | 推理移到 Python |
| `inference/` 整个目录 | 推理移到 Python |
| `download.rs` | 下载移到 Python |
| `sidecar.rs` | GPU 检测移到 Python |

---

## 8. ASR（待定）

| 方案 | 模型 | 依赖 | 说明 |
|---|---|---|---|
| A | SenseVoice-Small | funasr + torch | 中文识别优秀 |
| B | Paraformer | funasr + torch | 非自回归，毫秒级 |
| C | Qwen3-ASR | llama-cpp-python | 轻量但需额外 binding |
| D | 先不做 | — | Tauri 骨架保留 |

---

## 9. 执行顺序

1. **搭 `python-backend/`**：sidecar 主循环 + IPC 协议
2. **接入 Kokoro TTS**：下载 + 推理，验证质量
3. **接入模型下载**：huggingface_hub，进度回调
4. **Rust 侧改造**：推理/下载命令转发到 Python，删除旧模块
5. **前端零改动**验证
6. **ASR 接入**
7. **打包**：PyInstaller/Nuitka 打包 Python 到 Tauri 安装包
