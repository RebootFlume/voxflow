# PyTorch 推理框架技术方案

> 状态：**运行时层已实现并发布**（CPU/CUDA 两个独立运行时包、SHA-256 校验、manifest 校验、smoke test、下载与框架页接入）；**模型适配层尚未实现**（`load_model` / `transcribe` / `synthesize` 未接线）
>
> 适用版本：VoxFlow 当前多推理框架架构
>
> 目标平台：Windows x64
>
> 本文同时记录最终技术方案、备选方案评估，以及形成该方案的决策沿革。后续实现以本文为执行基线；实现过程中若改变关键决策，应同步更新本文的“决策记录”和“当前结论”。

---

## 1. 结论摘要

VoxFlow 的 PyTorch 框架采用**按需下载的独立 Python 推理运行时 ZIP**，不把 Python、PyTorch 或 CUDA 运行库放入 VoxFlow 主程序。

最终运行结构：

```text
VoxFlow.exe                         # Tauri/Rust 主程序
    │
    │ 启动子进程 + IPC
    ▼
libs/pytorch-cpu/python.exe         # CPU 运行时（二选一）
libs/pytorch-cuda130/python.exe     # CUDA 13.0 运行时（含 CPU 能力）
    └── worker.py                   # PyTorch 推理 worker
            └── torch / numpy / CUDA DLL
```

分发结构：

```text
构建机组装完整运行时目录
    ↓
压缩为版本固定的 ZIP
    ↓
上传到 VoxFlow GitHub Release / runtime-assets
    ↓
用户在 VoxFlow 中选择 PyTorch 后按需下载
    ↓
Rust 校验、解压、smoke test、启动 worker
```

### 1.1 最终选型

| 项 | 决定 |
|---|---|
| 主程序 | 保持纯 Rust/Tauri，不依赖 Python/PyTorch |
| PyTorch 进程 | 独立 Python worker 子进程 |
| Python 运行时 | 随 PyTorch 框架包携带，不依赖用户系统 Python |
| 下载方式 | 用户选择框架后下载完整 ZIP |
| Python 包 | 构建时固定版本，发布时预装，不在用户机器运行 pip |
| IPC | 第一版采用 stdin/stdout，控制消息使用 JSON |
| 模型 | 与 PyTorch 运行时分离下载 |
| 崩溃隔离 | worker/PyTorch 崩溃不得带走 VoxFlow 主程序 |
| 首版打包 | 先使用透明的嵌入式 Python 目录 ZIP，不急于 PyInstaller 单文件 |
| 后续封装 | 可评估 PyInstaller `--onedir`，但仍以目录整体压缩为 ZIP 分发 |
| 分包 | CPU 与 CUDA 发布为**两个独立运行时包**，互不依赖、不互为补丁 |
| 音频依赖 | 第一版**不含 `torchaudio`**；待真实 ASR/TTS 模型定型后再决定 |
| 固定版本 | Python 3.11.9 + torch 2.14.0（`+cpu` 与 `+cu130`）|
| 归档格式 | 标准 **ZIP**（7-Zip `-tzip -mx=5`），运行时目录内容**平铺在 ZIP 根**，无包装目录 |
| 资产托管 | 本仓库 GitHub Release 专用 tag `runtime-assets` |
| 完整性 | 归档 SHA-256 + 解压后 marker/aux_files/manifest 三重校验 |

### 1.2 一句话解释

> PyTorch 不是 VoxFlow 的编译期依赖，而是一个可选的、包含独立 Python 环境和 PyTorch 依赖的运行时包；Rust 只负责下载、校验、启动和管理 Python worker，并通过 IPC 使用它。

---

## 2. 背景和目标

当前 VoxFlow 已采用独立推理进程：

```text
GGUF   → llama-server.exe
ONNX   → sherpa-onnx websocket server
```

现有架构目标：

1. 推理引擎崩溃不影响桌面主程序；
2. 框架可独立下载和更新；
3. 用户未选择某个框架时，不下载该框架运行时；
4. 主程序不依赖用户系统中的 Python、pip 或 CUDA Toolkit；
5. 新增框架通过现有引擎注册表接入，而不是在调用方增加框架分支。

PyTorch 的主要用途是为后续模型（例如 PyTorch/TorchScript 形式的 ASR/TTS 模型）提供运行时。它与 llama.cpp、sherpa-onnx 的最大区别是：常见 PyTorch 模型依赖 Python 生态、预处理逻辑和模型适配代码。因此不能只把一个 DLL 或一个通用 EXE 当作完整框架分发。

---

## 3. 运行时总体架构

### 3.1 进程边界

```text
┌─────────────────────────────────────────────────────────────┐
│ VoxFlow.exe                                                 │
│ Tauri + React + Rust 主进程                                 │
│                                                             │
│ - 框架状态与下载                                            │
│ - 模型状态与 UI                                             │
│ - 启动/停止/监控 worker                                     │
│ - 统一 AsrEngine/TtsEngine 接口                             │
│ - 不加载 Python/PyTorch DLL                                │
└──────────────────────┬──────────────────────────────────────┘
                       │ stdin/stdout IPC
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Python worker 子进程                                        │
│ libs/pytorch-<variant>/python.exe worker.py                │
│                                                             │
│ - import torch                                             │
│ - 加载 PyTorch 模型                                         │
│ - 音频预处理与后处理                                        │
│ - 执行 CPU/CUDA 推理                                        │
│ - 返回统一 JSON 响应                                        │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ PyTorch Python 包、原生 DLL、CUDA 运行库、模型               │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 为什么必须是子进程

PyTorch 运行时包含大量 native DLL，可能发生：

- CUDA 初始化失败；
- 驱动或 CUDA 版本不兼容；
- 显存不足；
- native 算子崩溃；
- 第三方扩展崩溃；
- 模型或输入触发底层错误；
- DLL 加载失败。

如果 PyTorch 直接加载到 VoxFlow 主进程，native crash 可能直接关闭整个应用。独立 worker 后，主程序只需处理：

```text
worker 启动失败
worker 返回错误
worker 超时
worker 异常退出
worker 被系统终止
```

主程序可以保留 UI、日志、模型管理和重启能力。

### 3.3 与现有框架的对应关系

```text
gguf              → llama-server 子进程 + HTTP
onnx              → sherpa-onnx 子进程 + WebSocket
pytorch           → 独立 Python 子进程 + stdin/stdout
                    运行时包键：pytorch-cpu / pytorch-cuda130
```

Rust 侧新增 PyTorch adapter，统一实现现有 `AsrEngine` 或 `TtsEngine` 契约。调用方只依赖统一 trait 和 registry，不应在 `lib.rs`、`hotkey.rs` 或显存监控中添加 `if framework == "pytorch"` 分支。

---

## 4. 运行时包设计

### 4.1 官方提供的组件与需要自行组装的部分

官方分别提供：

1. **Python Windows Embeddable Package**：适合嵌入应用的 Windows Python ZIP；
2. **PyTorch Python wheels**：CPU/CUDA 版本的 PyTorch Python 包及原生 DLL；
3. 其他独立依赖的 wheels 或发行包。

官方没有提供针对 VoxFlow 的完整包：

```text
python.exe + PyTorch + worker.py + VoxFlow 协议
```

因此需要在构建机上自行组装、固定版本、测试并发布 VoxFlow 专用运行时 ZIP。

参考：

- [Python Windows embeddable package](https://docs.python.org/3/using/windows.html#embedded-distribution)
- [Python Windows downloads](https://www.python.org/downloads/windows/)
- [PyTorch Start Locally](https://pytorch.org/get-started/locally/)
- [PyTorch wheel index](https://download.pytorch.org/whl/)

### 4.2 运行时目录（实测形态）

首版使用透明目录，便于诊断 DLL、Python 包和版本问题。以下是 CPU 变体的实测布局（CUDA 变体多一层 CUDA DLL）：

```text
_work-<variant>/runtime/            → ZIP 根（平铺，无包装目录）
├── python.exe
├── pythonw.exe
├── python311.dll / python3.dll
├── python311.zip
├── python311._pth                  # 必须含 Lib/site-packages + import site
├── vcruntime140.dll / vcruntime140_1.dll
├── *.pyd（_socket / _ssl / _ctypes / _lzma / sqlite3 …）
├── worker.py
├── runtime-manifest.json           # 无 BOM
├── THIRD_PARTY_NOTICES/README.txt
└── Lib/site-packages/
    ├── torch/
    │   ├── __init__.py
    │   └── lib/                    # 所有原生 DLL 在这里，不在运行时根
    │       ├── torch_cpu.dll        (291.8 MiB)
    │       ├── torch_python.dll / c10.dll / libiomp5md.dll / zlibwapi.dll …
    │       └── CUDA 家族 DLL        # 仅 CUDA 变体：29 个，≈2.34 GiB
    ├── torch-2.14.0+<variant>.dist-info/
    ├── numpy/ / numpy.libs/
    ├── sympy/ / mpmath/ / networkx/ / jinja2/ / markupsafe/
    ├── filelock/ / fsspec/ / typing_extensions.py / setuptools/
    └── _distutils_hack/ / distutils-precedence.pth
```

关键修正（早期方案稿）

- 原生 DLL 位于 `Lib/site-packages/torch/lib/`，**不在运行时根目录**；
- 第一版不含 `torchaudio` 与 `soundfile`；
- ZIP 根必须直接是 `python.exe`，不能多包一层目录 —— 否则 marker 解析失败。

实测体积（含模型适配层，2026-09 发布版）：

```text
                 归档 ZIP       解压后         文件数
pytorch-cpu      220.5 MiB     771.3 MiB      22,844
pytorch-cuda130  220.9 MiB     773.8 MiB      （主包，不含 CUDA 库）
  └─ cuda13-libs 1771.4 MiB   2423.0 MiB      （辅包，29 个 CUDA 运行库）
```

加入模型适配层后主包从 155.1 MiB 涨到 220.5 MiB（+65 MiB）：transformers 栈（≈18 MiB）
+ 中文 G2P（misaki / jieba 词典 / pypinyin-dict ≈ 30 MiB）+ 其余轻量依赖。

### 4.3 运行时和模型分离

PyTorch 运行时包不包含具体模型：

```text
PyTorch runtime:
    Python + torch + worker + DLL

PyTorch model:
    权重 + tokenizer + config + 模型 manifest
```

建议目录：

```text
libs/pytorch-cpu/           或  libs/pytorch-cuda130/
    └── runtime-manifest.json

data/models/pytorch/<model-id>/
    ├── model.pt 或受支持权重格式
    ├── config.json
    ├── tokenizer.json
    └── manifest.json
```

这样多个模型共享同一套 Python/PyTorch 运行时，升级运行时也不会重复下载模型。

### 4.4 CPU 与 CUDA 包（已实现）

不要让用户自行组合 torch、CUDA 和 DLL。发布预先验证的完整变体。**当前发布两个独立包**：

| | `pytorch-cpu` | `pytorch-cuda130` |
|---|---|---|
| 资产名 | `voxflow-pytorch-cpu-py311-torch2.14.0-win-x64.zip` | `voxflow-pytorch-cuda130-py311-torch2.14.0-win-x64.zip` + `voxflow-pytorch-cuda130-cuda13-libs.zip` |
| 文件数 | 1 | 2（主包 + 运行库辅包，必须同装）|
| 大小 | 231,220,586 B（220.5 MiB） | 231,666,165 B（220.9 MiB）+ 1,857,483,063 B（1771.4 MiB）|
| SHA-256 | `07d82e34…85e7` | `d1c50052…f545` + `42d42881…f91` |
| 解压占用 | 771.3 MiB | 773.8 MiB + 2423.0 MiB |
| wheel | `torch-2.14.0+cpu` | `torch-2.14.0+cu130` |
| target_dir | `libs/pytorch-cpu` | `libs/pytorch-cuda130` |
| engine 键 | `pytorch` | `pytorch` |
| supports_cpu | true | true |
| supports_cuda | false | true |

**能力是包含关系，文件不是。** 实测：

```text
CUDA 运行时：torch 2.14.0+cu130, cuda_available=true, CPU matmul 可用
CPU  运行时：torch 2.14.0+cpu,   cuda_available=false, CPU matmul 可用
```

逐文件比对两个运行时：

```text
共同文件 16,771 / 仅 CPU 99（几乎全是 dist-info）/ 仅 CUDA 136（29 个 NVIDIA DLL）
同名但内容不同 828，含 torch_cpu.dll、torch_python.dll、大量 .pyc
```

因此：

- CUDA 包在**设备能力上**覆盖 CPU 包 ⇒ 已装 CUDA 包时切 CPU 不需要再下载；
- 但两者**不是补丁/增量关系**，核心二进制不同 ⇒ 装了 CPU 包再切 CUDA 必须重下 CUDA 包；
- 两者必须各自 `target_dir`，绝不能共用目录（会互相覆盖且 manifest 校验失败）。

设备选择规则（`inference::runtime_download`）：

```text
installed_runtime_for_device("pytorch", device)
  cpu  → 已安装且 supports_cpu 的包，优先 CUDA 变体（避免重复下载）
  cuda → 已安装且 supports_cuda 的包（CPU 包被过滤）

preferred_runtime_for_device("pytorch", device)
  已安装优先；未安装时 cpu → pytorch-cpu，cuda → pytorch-cuda130
```

CUDA 变体必须记录并测试：

- PyTorch 版本：`2.14.0+cu130`
- CUDA runtime：`13.0`（wheel 内自带 `cudart64_13.dll` 等，不需用户装 CUDA Toolkit）
- NVIDIA 驱动最低要求：以 `torch.cuda.is_available()` 实测为准
- Windows x64、Python 3.11.9、worker 协议版本 1

### 4.5 Manifest（已实现）

运行时包根目录放 `runtime-manifest.json`，**必须无 BOM**。实际内容：

```json
{
  "framework": "pytorch-python",
  "variant": "cpu",
  "python": "3.11.9",
  "torch": "2.14.0+cpu",
  "torchaudio": null,
  "cuda": null,
  "arch": "x86_64-pc-windows-msvc",
  "worker_protocol": 1,
  "entry": "python.exe",
  "script": "worker.py",
  "smoke_test": "python.exe worker.py --smoke-test",
  "asset": "voxflow-pytorch-cpu-py311-torch2.14.0-win-x64.zip",
  "status": "built"
}
```

CUDA 变体差异只有三处：

```json
"variant": "cuda130",
"torch": "2.14.0+cu130",
"cuda": "13.0"
```

字段语义澄清（避免与引擎键混淆）：

```text
manifest.framework = "pytorch-python"   → 运行时形态标识（描述"这是 Python 形态的 PyTorch 运行时"）
RUNTIME_PACKAGES.engine = "pytorch"     → 引擎注册键（registry / ModelSpec.framework 使用）
RUNTIME_PACKAGES.framework = "pytorch-cpu" / "pytorch-cuda130"  → 下载包唯一键
```

三者含义不同，不得互相代入。

Rust 的 `runtime_manifest_matches` 逐项校验（`inference/runtime_download.rs`）：

```text
worker_protocol == 1
variant == RuntimePkg.variant
torch 以 "2.14.0" 开头
script == "worker.py"
```

解析前剥离 UTF-8 BOM —— Windows PowerShell 5.1 的 `Set-Content -Encoding utf8`
会写 `EF BB BF`，而 `serde_json` 不接受，会导致"装完仍显示不完整"。构建脚本
已改为 `[IO.File]::WriteAllText(..., UTF8Encoding($false))`，Rust 侧同时兼容带 BOM 的旧包。

### 4.6 安装校验与设备降级（已实现）

`RUNTIME_PACKAGES` 每个条目声明：

```rust
framework / engine / name / variant / supports_cpu / supports_cuda
version / sha256 / unpacked_bytes / manifest / url / aux_url / aux_dir
aux_files / inner_dir / target_dir / marker / port_base / smoke_args / smoke_probe
```

下载安装顺序：

```text
1. 磁盘预检：need = 下载量 + unpacked_bytes（旧实现 size*2 会低估约 1 GiB）
2. 下载主包（流式 + 断点续传 + 可取消）
3. 校验主包 SHA-256（sha256 为空表示未固定，跳过 —— llama/sherpa 目前为空）
4. 下载 aux 包（若有）
5. 分别解压到独立临时目录 → 主包落 target_dir，aux 落 target_dir/aux_dir
6. 完整性校验：marker + aux_files + manifest 语义
7. smoke test：`python.exe worker.py --smoke-test`，stdout 必须 `"ok": true`
8. 失败则报具体原因（缺文件清单 / SHA 不符 / worker 退出码 + stdout + stderr）
```

smoke test 验证：

1. Python 能启动；
2. `import torch` 成功；
3. 版本与 manifest 一致；
4. CPU 变体能完成最小 CPU Tensor 运算；
5. CUDA 变体能识别 CUDA（`cuda_version` / `device_count`）；
6. worker 返回协议 JSON；
7. 缺 CUDA/驱动时返回可诊断错误，而不是静默卡住。

设备降级（已定，模型层接线时执行）：

```text
请求 cuda → 包 supports_cuda=true 且 torch.cuda.is_available() → 用 CUDA
          → 否则报错并提示，不静默回退
请求 cpu  → 任意已安装包都可用（CUDA 包亦可）
```

### 4.8 模型适配层（已实现）

运行时只提供"能跑 PyTorch"；要"能转写/能合成"，还需要模型适配层。三件事：

**① 模型直接来自 HuggingFace，不做镜像**

模型不经过 VoxFlow 的 Release 二次分发：`ModelSpec.source` 写 `HuggingFace { repo, revision }`，
`entries[].files` 逐个列文件名，下载走既有 HF 逐文件直链（`hf_file_url` + `net`，token 只发
huggingface.co）。`revision` 钉到 commit，避免上游更新导致同一模型内容漂移。

```text
ASR: openai/whisper-tiny         rev 169d4a43…  model.safetensors 145MB + 7 个配置/tokenizer 文件
TTS: hexgrad/Kokoro-82M          rev f3ff3571…  kokoro-v1_0.pth 313MB + config.json + 2 个中文音色
```

**② 描述符声明适配器，模型包不含代码**

`BackendSpec::PyTorch(PyTorchSpec { adapter, language, voice })`：

```rust
PyTorch(PyTorchSpec { adapter: "whisper", language: "zh", voice: "" })          // ASR
PyTorch(PyTorchSpec { adapter: "kokoro",  language: "zh", voice: "zf_xiaobei" }) // TTS
```

`adapter` 必须是**运行时内置白名单**里的 id（worker 只认这几个）；模型目录只放权重与配置，
不携带可执行代码 —— 这是 §6.2 安全约束的落点。

`FileRole::Extra` 是新加的条目角色：`Main` 仍是主权重（供 `main_model_file` 解析），
其余运行必需文件（config / tokenizer / voices）用 `Extra` 声明，`entry_union` 照样下载。

**③ Rust 侧适配器与注册**

```text
inference/pytorch.rs        长驻 worker 客户端（spawn / IPC / 超时 / 崩溃重启 / stderr 诊断 / PID）
inference/pytorch_asr.rs    PyTorchAsrAdapter → AsrEngine（transcribe 写临时 WAV，ctx 走 prompt_ids）
tts/engine/pytorch.rs       PyTorchTtsEngine → TtsEngine（synthesize 由 worker 写 WAV，Rust 读回）
inference/registry.rs       ("pytorch", …) 注册
tts/registry.rs             ("pytorch", …) 注册
```

**④ 运行时门禁按"任一包就绪"**

models JSON 新增 `runtime_keys`（该框架全部运行时包）：

```text
gguf  → ["gguf"]
onnx  → ["onnx"]
pytorch → ["pytorch-cpu", "pytorch-cuda130"]
```

前端 `runtimeKeysOf()` + 门禁/横幅/徽标改为"任一 ready 即放行"，避免装了 CUDA 包却被判缺
CPU 包（或反之）。单 key 的 `runtime_key` 保留给展示与过滤。

**⑤ 依赖与 vendor（可复现）**

模型适配层依赖在构建脚本里**逐项锁版本**、从 PyPI 直连取（镜像会漂移，实测缺 `kokoro 0.9.4`）。
Kokoro 推理代码以 vendor 形式随运行时发布（Apache-2.0，`Lib/site-packages/voxflow_kokoro/`
+ 许可文件），**不装上游 `kokoro` 包** —— 因为它的 `pipeline` 会 import `misaki.en`，
把 spaCy + spacy-curated-transformers（约 +28 MiB，纯为英文 G2P）拖进运行时。

### 4.9 CUDA 打包拆分为主包 + 运行库辅包（已实施）

动机：GitHub Release 单资产上限 **2 GiB**，原先单包 1927.0 MiB 只剩约 118 MiB 余量，
PyTorch 升级或加依赖就会越界。

做法：沿用现有 aux 机制（llama.cpp 的 cudart、sherpa 的 NVIDIA 运行库都是这么做的），
**不改 `RuntimePkg` 结构**，只填数据：

```rust
url:        主包（除 CUDA DLL 外的全部内容）            155.6 MiB / 163,124,996 B
aux_url:    运行库辅包（29 个 DLL，平铺在 ZIP 根）      1771.4 MiB / 1,857,483,063 B
aux_dir:    "Lib/site-packages/torch/lib"
aux_files:  CUDA130_AUX_FILES（29 条相对路径）
sha256:     主包 SHA-256
aux_sha256: 辅包 SHA-256（新增字段，下载后校验）
```

实测拆分明细：

```text
torch/lib 共 39 个 DLL，2737.4 MiB
├── 主包保留 10 个（torch_cpu.dll 291.8 / torch_python.dll / torch.dll / c10.dll /
│   shm.dll / torch_global_deps.dll / libiomp5md.dll / libiompstubs5md.dll /
│   uv.dll / zlibwapi.dll）                              ≈ 314 MiB
└── 辅包 29 个（CUDA 运行库）                            ≈ 2423 MiB
    cublasLt64_13 455.8 / torch_cuda 403.1 / cufft64_12 271.2 /
    cudnn_engines_precompiled 211.6 / cusparse64_12 143.4 / cusolver64_12 120.6 /
    cudnn_graph 105.8 / cudnn_adv 101.6 / … / nvToolsExt64_1 0.03
```

**为什么按这个边界切、而不是按功能再细分**（有实验依据）：

```text
把任一组 DLL 移出 torch/lib → 跑 import torch：
  cublas(2)        ❌ WinError 126 … cusolver64_12.dll 依赖缺失
  cudnn(10)        ❌ WinError 126 … shm.dll 依赖缺失
  cusolver+cusparse ❌ WinError 126 … shm.dll 依赖缺失
  cufft(2)         ❌ WinError 126 … shm.dll 依赖缺失
  nvrtc+nvJitLink  ❌ WinError 126 … caffe2_nvrtc.dll 依赖缺失
  profiling(3)     ❌ WinError 126 … shm.dll 依赖缺失
  curand(1)        ✅ 通过（torch 的 CUDA RNG 不走这个独立 DLL）
```

原因是 `torch/__init__.py::_load_dll_libraries()` 在 import 阶段就加载 `torch/lib`
下**全部** DLL。所以：

- 辅包**必须与主包一起安装**，不能做成"可选组件"；
- 拆分的收益是**绕开单资产上限 + 重试粒度按片**，不是减少总下载量；
- 边界取"全部 CUDA 运行库"这一个自然切面，既满足上限又不需要按库族维护多片。

`RuntimePkg.aux_url` 仍是 `Option<&'static str>`（每包最多一个附加包）。当前两片方案
用满该字段即可；若将来还需第三片（例如再加入 `torchaudio` 后主包仍可能变大），
需把它改成切片并扩展下载/进度/落位三处循环。

代价：磁盘预检按 `下载量 + unpacked_bytes` 计，CUDA 变体峰值 ≈ 2.02 GB（两归档）
+ 3.06 GB（解压）≈ 5.16 GB。

可选的进一步体积优化（未做）：主包删除 `torch/include`（ZIP 10.6 MiB）与
`torch/lib/*.lib`（ZIP 6.5 MiB），运行时用不到，仅对从源码编译扩展的人有价值。

---

## 5. Python worker 设计

### 5.1 Rust 的职责

Rust 主程序负责：

1. 查询框架安装状态；
2. 下载并校验 ZIP；
3. 解压到 `libs/pytorch-<variant>/`；
4. 执行 smoke test；
5. 启动 `python.exe worker.py`；
6. 管理 stdin/stdout/stderr；
7. 设置受控环境变量和工作目录；
8. 发送加载、卸载、推理、关闭命令；
9. 监控超时和异常退出；
10. 将 worker 状态转换为 VoxFlow 统一事件。

Rust 不要求用户安装 Python，也不运行用户系统的 pip。

### 5.2 worker 的职责

Python worker 负责：

1. 加载固定的 PyTorch 适配器；
2. 加载模型；
3. 将音频转换为模型需要的输入；
4. 选择 CPU/CUDA device；
5. 执行推理；
6. 将输出转换为 VoxFlow 协议；
7. 捕获 Python 异常并返回错误；
8. 处理 `shutdown`；
9. 在异常退出前尽可能释放资源。

### 5.3 长驻 worker

不要每次转写都启动一个新 Python：

```text
不采用：启动 → import torch → 加载模型 → 转写 → 退出
```

采用：

```text
启动 worker → import torch → load_model
    → 多次 transcribe
    → unload_model / load_other_model
    → shutdown
```

这样避免重复支付 Python 启动、CUDA 初始化、模型加载和显存分配成本。

### 5.4 IPC 第一版

第一版采用 stdin/stdout：

```text
stdin  ：Rust → worker，JSON 命令
stdout ：worker → Rust，JSON 响应/事件
stderr ：worker → Rust，诊断日志
```

首版音频可以使用临时 WAV 路径，避免过早设计二进制协议：

```json
{"method":"transcribe","audio_path":"data/tmp/request-123.wav"}
```

后续性能需要时，再改为：

```text
长度前缀 + JSON header + 二进制 PCM
```

协议命令建议：

```text
ping
runtime_info
load_model
unload_model
transcribe
get_status
shutdown
```

每个请求必须有 request id，并且响应明确表示：

```json
{"id":7,"ok":true,"text":"..."}
```

或：

```json
{"id":7,"ok":false,"error":{"kind":"out_of_memory","message":"..."}}
```

### 5.5 worker 失败处理

Rust 必须区分：

```text
启动失败       → runtime_error
加载失败       → model_error
推理失败       → recognition_error
超时           → worker_timeout
异常退出       → worker_crashed
缺运行时       → runtime_missing
```

worker 崩溃后：

1. 标记当前模型未加载；
2. 收集 stderr 和退出码；
3. 释放/清理主进程状态；
4. UI 显示可诊断错误；
5. 用户主动重试时再启动，不自动无限重启。

---

## 6. 模型格式和安全边界

### 6.1 不承诺支持任意 `.pt` / `.pth`

普通 `.pth` 经常只是 Python `state_dict`，不包含模型结构。Rust 或通用 worker 无法自动恢复任意 Python 模型。

第一版模型必须符合 VoxFlow 自己的模型包协议，例如：

```text
VoxFlow PyTorch Model Package
├── model.pt
├── config.json
├── tokenizer.json
├── audio.json
└── manifest.json
```

manifest 至少描述：

```json
{
  "format": "voxflow-pytorch",
  "format_version": 1,
  "task": "asr",
  "sample_rate": 16000,
  "input": "float32_pcm",
  "output": "text",
  "model_format": "torchscript"
}
```

第一版可以优先支持 TorchScript，或只支持经过项目适配器验证的权重格式。模型适配器、预处理和后处理应由 VoxFlow worker 内置，而不是执行模型目录中的任意 Python 文件。

### 6.2 安全要求

不允许默认从远程模型包执行任意 Python 代码。至少遵守：

1. 优先使用 `safetensors` 或受控的 TorchScript；
2. 对必须使用 `torch.load` 的路径采用安全配置，并明确允许的格式；
3. 不默认启用 `trust_remote_code`；
4. 模型和运行时下载完成后校验 SHA-256；
5. worker 不接受任意脚本路径作为执行入口；
6. 模型 manifest 必须声明 task、输入、输出和版本；
7. worker 的 IPC 只接受 VoxFlow 定义的命令集合。

---

## 7. 打包与发布流程

### 7.1 首版推荐：透明嵌入式 Python 目录（已实现）

首版不急于使用 PyInstaller。使用 Python 官方 Windows Embeddable Package，加上预装的 site-packages 和 worker。实际脚本：`scripts/build-pytorch-runtime.ps1`。

```text
1. 下载固定版本 Python embeddable ZIP（3.11.9）
2. 解压到构建临时目录
3. pip download --python-version 3.11 --platform win_amd64 --implementation cp --abi cp311
   （必须显式指定目标解释器，否则会下到构建机自身的 cp313 wheel）
4. 解压所有 wheel 到 Lib/site-packages（--only-binary=:all:，含 numpy）
5. 放入 worker.py、runtime-manifest.json（无 BOM）、THIRD_PARTY_NOTICES/
6. 配置 python311._pth：. / python311.zip / Lib/site-packages / import site
7. 用目录内 python.exe 执行 worker.py --smoke-test
8. 在 runtime 目录内用 7z -tzip 打包（ZIP 根平铺）
9. 计算 SHA-256（sha256sum），写入 Rust descriptor 与 sidecar 元数据
10. 上传到 runtime-assets Release，核对远程大小与本地一致
```

实测步骤 7 输出（CPU / CUDA）：

```json
{"ok": true, "protocol": 1, "result": {"status": "ready", "tensor_result": 32.0,
 "python": "3.11.9", "torch": "2.14.0+cpu", "cuda_available": false, "device_count": 0}}
{"ok": true, "protocol": 1, "result": {"status": "ready", "tensor_result": 32.0,
 "python": "3.11.9", "torch": "2.14.0+cu130", "cuda_available": true,
 "cuda_version": "13.0", "device_count": 1}}
```

这样运行时内部结构透明，缺 DLL、缺包、路径问题易于诊断。

### 7.2 可选后续：PyInstaller `--onedir`

`onedir` 和 ZIP 不是互斥选项：

```text
PyInstaller --onedir
    → 生成 worker 目录
    → 将整个目录压成 ZIP
    → VoxFlow 下载并解压
    → Rust 启动 worker.exe
```

`onedir` 会把 Python 解释器、字节码、包和 DLL 收集到 `worker.exe` 及其 `_internal/` 目录中。它不是删除 Python 环境，而是改变了分发形态。

后续若采用 PyInstaller，必须在干净 Windows 环境验证 PyTorch 动态模块和 CUDA DLL。不能因为生成了 `worker.exe` 就认为打包完成。

### 7.3 不推荐首版：PyInstaller `--onefile`

`--onefile` 通常在启动时先将内置内容解压到临时目录，再运行 worker。它不会减少 PyTorch 体积，还会带来：

- 启动更慢；
- 临时磁盘需求；
- 动态 DLL 问题更难诊断；
- 杀毒软件误报概率更高；
- 更新和故障定位粒度更差。

因此产品分发仍采用“目录运行时 + ZIP 下载”，而不是巨型单文件 EXE。

### 7.4 发布资产（已上传）

不要将大型运行时 ZIP 提交到源码 Git 历史。已发布到 GitHub Release 专用 tag：

```text
https://github.com/RebootFlume/voxflow/releases/tag/runtime-assets
├── voxflow-pytorch-cpu-py311-torch2.14.0-win-x64.zip          231,220,586 B
├── voxflow-pytorch-cuda130-py311-torch2.14.0-win-x64.zip      231,666,165 B（主包）
├── voxflow-pytorch-cuda130-cuda13-libs.zip                  1,857,483,063 B（辅包）
└── voxflow-sherpa-cuda12-runtime.zip（既有，未改动）
```

Rust 中固定（`RUNTIME_PACKAGES` 数据行）：

```text
framework / engine / name / variant / supports_cpu / supports_cuda
version / sha256 / unpacked_bytes / manifest
url / aux_url / aux_dir / aux_files
inner_dir / target_dir / marker / port_base / smoke_args / smoke_probe
```

构建脚本：`scripts/build-pytorch-runtime.ps1 -Variant cpu|cuda130`
（下载 CPython embeddable → 下载 `cp311` wheel → 解压到 site-packages → 写无 BOM manifest
→ 打包 → smoke test → 输出 SHA-256 元数据）

打包硬性要求（踩过的坑）：

```text
必须在 runtime 目录内打包（Push-Location $runtime），ZIP 根直接是 python.exe
不能在仓库根用 runtime/* 通配 —— 会把 dist-bundle/... 全路径写进归档，marker 解析必然失败
manifest 必须无 BOM —— 否则 serde_json 解析失败，包恒被判"不完整"
```

### 7.5 第三方许可

运行时包附带 `THIRD_PARTY_NOTICES/README.txt`，记录变体、Python/PyTorch 版本与上游来源：

```text
THIRD_PARTY_NOTICES/
└── README.txt        # variant / Python / PyTorch / wheel index URL

Lib/site-packages/*.dist-info/    # 各 wheel 自带的许可证正文（torch/ numpy/ …）
```

现状说明：包内已保留各 wheel 的 `dist-info` 许可文件与一个 README 索引，
但**尚未把许可证正文集中抽取成逐项文本**（原方案的 `Python.txt` / `PyTorch.txt` /
`NumPy.txt` / `TorchAudio.txt`）。若要以更严格的形式分发，需要补这一步；第一版依赖
wheel 自带许可文件。`torchaudio` 不在包内，故不再需要其许可文本。

发布前核对 Python、PyTorch、CUDA 相关组件及所有 Python 依赖的分发许可。

---

## 8. 与现有 VoxFlow 代码的接入点

### 8.1 引擎层

新增：

```text
src-tauri/src/inference/pytorch.rs
```

实现现有 `AsrEngine`：

```rust
pub struct PyTorchAsrAdapter {
    // 子进程、IPC、状态、当前模型等
}
```

至少覆盖：

```text
framework()
load_model()
load_model_with_stage_and_device()
unload()
is_loaded()
current_model()
transcribe()
vram_estimate_mb()
pid()
```

TTS 侧按现有 `TtsEngine` 和 `TtsRegistry` 规则接入。

### 8.2 注册表

在 `inference::registry` 注册一行：

```text
("pytorch", Arc::new(PyTorchAsrAdapter::new()))
```

不得在调用方追加 PyTorch 专用 `if/else`。

### 8.3 框架描述符和运行时包（运行时部分已实现）

现有数据驱动位置需要增加 PyTorch 条目：

```text
RUNTIME_PACKAGES            ✅ 已加 pytorch-cpu / pytorch-cuda130 两行
inference::runtime_download ✅ SmokeProbe::PythonWorker 已加，无框架分支
model_manager::FRAMEWORKS   ⛔ 尚未加 pytorch 行（模型层接入时一起加）
tts/spec.rs 的模型描述符     ⛔ 尚无 framework="pytorch" 的模型
BackendSpec                 ⛔ 需新增 PyTorch 变体 + 扩展 kind↔backend↔framework 一致性断言
```

已实现的运行时包字段：

```rust
framework / engine / name / variant / supports_cpu / supports_cuda
version / sha256 / unpacked_bytes / manifest / url / aux_url / aux_dir
aux_files / inner_dir / target_dir / marker / port_base / smoke_args / smoke_probe
```

`SmokeProbe::PythonWorker` 已按数据驱动接入：`smoke_test_runtime` 里只有一处
`matches!(pkg.smoke_probe, SmokeProbe::PythonWorker)` 分支，llama / sherpa 的
HTTP 与 stderr 探针逻辑未改动。

### 8.4 前端（已实现）

复用现有 FrameworkPanel 的：下载、取消、验证、修复、三态状态显示。

PyTorch 占位卡片**已删除**，改为 Rust 下发的真实 runtime 行：

```text
PyTorch  cpu       2.14.0-py311-cpu       CPU
PyTorch  cuda130   2.14.0-py311-cuda130   CPU · CUDA
```

CPU/CUDA 是同一 `engine = "pytorch"` 的两个 package key，各自独立下载/校验/修复；
用户不需要也不能手动拼 DLL。设备选择由 §4.4 的 resolver 决定，前端不参与拼装。

---

## 9. 备选技术路线评估

### 9.1 `tch-rs + LibTorch`

结构：

```text
Rust worker
    ↓ tch-rs / torch-sys
官方 LibTorch DLL
```

优点：

- 不需要 Python；
- Rust 侧接口自然；
- 独立 worker 仍可隔离 native crash；
- 适合固定的 TorchScript/native 模型；
- `tch-rs` 已经提供 Rust 到 LibTorch 的 wrapper。

缺点：

- `tch-rs` 是社区项目，不是 PyTorch 官方稳定 C ABI；
- `tch-rs` 与 LibTorch 版本绑定；
- Windows MSVC、Debug/Release、DLL 路径和 CUDA 组合需要严格匹配；
- 不能直接使用任意 Python 模型、Transformers 或自定义 Python 预处理；
- LibTorch 运行时仍然很大。

当前不作为第一版：Python 生态对目标模型更灵活，且可以直接复用官方 Python 模型代码。

### 9.2 Rust worker + 自定义 C++ bridge + LibTorch

结构：

```text
Rust worker → 自定义 C ABI → C++ bridge → LibTorch
```

优点：

- 可以隔离 C++ ABI；
- 适合长期维护的固定 native API。

缺点：

- 增加一层自维护 bridge；
- 需要处理 C++ ABI、异常、Tensor 生命周期和构建工具链；
- 对当前目标属于不必要的复杂度。

不采纳为第一版。

### 9.3 纯 C++ worker + LibTorch

优点：

- 官方 LibTorch C++ API 直接可用；
- 少一层 Rust/C++ FFI。

缺点：

- worker 协议、进程管理和模型适配需要用 C++ 维护；
- 对 Python 生态模型兼容性仍然有限。

不采纳为第一版。

### 9.4 Python worker + 系统 Python

优点：开发最快。

缺点：

- 依赖用户环境；
- 版本不可控；
- 不能满足 VoxFlow 的零 Python 前置要求。

仅用于开发阶段快速验证，不用于产品分发。

### 9.5 Python worker + 独立 Python 运行时

优点：

- 不污染系统 Python；
- PyTorch/Transformers 生态兼容性最好（`torchaudio` 等音频库按需再加）；
- 用户不需要安装 Python；
- 与“框架按需下载”模型一致；
- worker 崩溃可隔离。

缺点：

- 运行时体积较大；
- 需要自行构建和发布完整 ZIP；
- Python 依赖、CUDA 和模型安全需要治理。

这是当前推荐方案。

---

## 10. 技术选型沿革和决策记录

### 10.1 初始问题

需求是：引入 PyTorch，但不能让所有用户的 VoxFlow 安装包都携带 Python/PyTorch；用户只有选择该框架时，才下载对应运行时。

### 10.2 方案一：直接使用 PyTorch DLL/C++ API

首先考虑 LibTorch：官方提供 DLL、头文件和 C++ API，可以作为独立运行时下载。

问题：它没有一个通用的 `pytorch.exe`，下载 DLL 后不能自动加载任意模型。还需要自己编写 worker，并面对 C++ ABI、模型导出和 CUDA 部署问题。

结论：可行，但需要额外 native worker，且对 Python 模型生态不够灵活。

### 10.3 方案二：Rust worker + C++ bridge

为避免 Rust 直接接触 C++ ABI，考虑 Rust 子进程调用一个自定义 C ABI bridge，再由 bridge 调 LibTorch。

问题：虽然边界清晰，但额外增加 bridge DLL 和维护成本；对于固定 PyTorch 模型可以成立，对需要 Python 生态的模型仍然不够直接。

结论：保留为未来纯 native 路线，不作为第一版。

### 10.4 方案三：`tch-rs`

发现 `tch-rs` 已经提供 Rust 对 LibTorch C++ API 的 wrapper，并由 `torch-sys` 管理部分 C/C++ wrapper 构建。

优点是可以只写 Rust worker；缺点是它不是 PyTorch 官方项目，并且严格绑定 `tch-rs`/LibTorch/PyTorch 版本。它适合固定 TorchScript/native 模型，但不等于官方稳定 C ABI。

结论：可行，作为未来的纯 Rust/LibTorch 方案；第一版仍优先 Python 生态。

### 10.5 方案四：Rust 启动 Python worker

进一步确认：Rust 不需要把 Python 嵌入主进程，只需启动一个 Python 子进程并通过 IPC 通信。Python 运行时可以随框架 ZIP 下载，系统不需要预装 Python。

这个方案：

- 复用 PyTorch 官方 Python wheels；
- 可使用 PyTorch 官方 Python 生态及模型适配代码（`torchaudio` 视模型需要后续再加）；
- 与当前 llama/sherpa 的子进程隔离原则一致；
- 只在选择 PyTorch 后增加用户磁盘占用；
- 不改变主程序的 Rust-only 发布形态。

结论：确定为当前首选。

### 10.6 方案五：PyInstaller 单文件/目录

考虑把 Python 环境和 worker 打成 EXE。

结论：

- `--onefile` 仍需启动时解压，PyTorch DLL 问题更难诊断，不作为首版；
- `--onedir` 可以作为未来封装方式，但最终仍压成 ZIP 下载；
- 首版先使用透明的“嵌入式 Python 目录 + site-packages + worker.py” ZIP，便于验证和维护。

### 10.7 当前最终决策（含实现状态）

```text
VoxFlow 主程序：纯 Rust/Tauri                                  ✅ 未变
PyTorch 框架：独立 Python runtime ZIP                          ✅ 已实现并发布
PyTorch 进程：Python worker 子进程                              🟡 协议骨架已有，模型命令待做
通信：stdin/stdout JSON                                        ✅ 协议已定
下载：用户选择框架后按需下载                                     ✅ 已实现（含 SHA-256/manifest 校验）
模型：与 runtime 分离                                          ✅ 目录与下载分离已定
首版打包：嵌入式 Python 目录                                     ✅ 已实现，未用 PyInstaller
```

### 10.8 实现阶段发生的决策修正

以下条目与原方案稿不一致，以本节为准：

| 项 | 原方案稿 | 实际实现 | 原因 |
|---|---|---|---|
| 固定 torch 版本 | 未定（`tch 0.26` ↔ torch 2.13 讨论） | **torch 2.14.0** | PyTorch 官方已有 `+cpu` / `+cu130` Windows wheel |
| CUDA 版本 | 12.6（`cuda126`） | **13.0（`cuda130`）** | 采用官方 `cu130` wheel，DLL 随 wheel 自带 |
| 音频依赖 | 含 `torchaudio` | **不含**（`torchaudio: null`） | 第一阶段只做运行时与 smoke test，模型未定 |
| variant 语义 | `cpu-or-cuda` 占位 | **两个独立包 `cpu` / `cuda130`** | 两者不是补丁关系，必须独立下载与校验 |
| runtime key | `pytorch` 单一键 | **包 key `pytorch-cpu` / `pytorch-cuda130`，engine 键 `pytorch`** | 下载键与引擎注册键分离，避免污染 registry 路由 |
| DLL 位置假设 | 运行时根目录 | **`Lib/site-packages/torch/lib/`** | 以 wheel 实际布局为准 |
| 磁盘预检 | `size * 2` | **`下载量 + unpacked_bytes`** | CUDA 包低估约 1 GiB，会在解压阶段爆盘 |
| 归档内路径 | 未明确 | **ZIP 根平铺，必须在 runtime 目录内打包** | 首次上传用了仓库根通配，归档含全路径，marker 解析必然失败 |
| manifest 编码 | 未明确 | **必须无 BOM** | PowerShell 5.1 `Set-Content -Encoding utf8` 写 BOM，`serde_json` 拒收导致包恒判"不完整" |
| 容量 | 未评估 | **CUDA 拆成主包 155.6 MiB + 运行库辅包 1771.4 MiB** | 单包 1927 MiB 距 GitHub 2 GiB 上限仅余 118 MiB；见 §4.7 |
| 辅包校验 | 无 | **`aux_sha256` 字段 + 下载后校验** | 辅包 1771 MiB 是下载主体，损坏要能明确报错而不是解压/smoke 阶段才失败 |
| 模型分发 | 未定 | **HF 直链下载，不做 Release 镜像**；`revision` 钉 commit | 模型由上游维护，重新分发无收益；钉 commit 才能复现 |
| 首个模型 | 未定 | **Whisper-tiny（ASR）+ Kokoro-82M（TTS）** | 打通两类链路；效果不是首版目标（Whisper-tiny 弱于现有 Qwen3-ASR） |
| TTS 代码来源 | 依赖 `kokoro` 包 | **vendor 4 个推理文件（Apache-2.0）** | 上游 `pipeline` 会 import `misaki.en` → spaCy + curated-transformers（+28 MiB，纯英文 G2P） |
| 依赖版本 | 不锁 | **逐项锁版本 + PyPI 直连** | 镜像会漂移且缺 `kokoro 0.9.4`；不锁版本无法复现运行时内容 |
| 多运行时门禁 | 单 `runtime_key` | **新增 `runtime_keys`，任一 ready 即放行** | PyTorch 有 cpu / cuda130 两包，单 key 会误判缺框架 |
| 条目文件角色 | `Main` / `Mmproj` | **新增 `Extra`** | PyTorch 模型的 config / tokenizer / voices 需要一并下载但不承担"主文件"角色 |

三次真实缺陷（已修复，留作回归教训）：

```text
1. 归档结构错误（运行时层）：7z 从仓库根打包 runtime/*，ZIP 内含 dist-bundle/... 全路径
   → libs/pytorch-cpu/python.exe 不存在 → 完整性校验必然失败

2. manifest BOM（运行时层）：CPU 包 manifest 带 EF BB BF → serde_json 解析失败 → 恒判 incomplete

3. worker 客户端自死锁（模型层，由新加的监督路径测试抓到）：
   call() 持有 self.inner 锁期间，错误/超时分支又调用 self.stderr_tail()
   → parking_lot::Mutex 不可重入 → 调用线程永久挂起
   （在应用里 = worker 一报错，加载/转写界面就永远卡在 loading）
   修复：改用 tail_of(&Running) 读已借出的 running；并补三条监督路径测试锁死该行为
```

---

## 11. 实施阶段与进度

### 阶段 0：运行时实验 ✅ 已完成

- 固定 Python 3.11.9、torch 2.14.0（`+cpu` / `+cu130`）；
- 构建 CPU runtime ZIP；
- 构建 CUDA runtime ZIP；
- 验证 `import torch`、CPU/CUDA Tensor 和 worker smoke test（本机 CUDA 驱动可用）；
- 端到端安装仿真：校验 SHA-256 → 解压 → marker/aux/manifest 校验 → smoke 通过。

遗留：尚未在**无系统 Python 的干净 Windows 机器**和**无 NVIDIA 驱动的机器**上验证。

### 阶段 1：Python worker 协议 ✅ 已完成

worker.py 实现命令：

```text
ping / runtime_info / smoke_test
load_model {model_dir, adapter, device, options}
unload_model
transcribe {wav, options}          ASR
synthesize {text, out_wav, options} TTS
shutdown
```

- 结构化错误：`unsupported_adapter` / `model_load_failed` / `not_loaded` / `bad_request` /
  `device_unavailable` / `io_error` / `worker_error`；
- 适配器白名单编译在 worker 内（`ADAPTERS = {whisper, kokoro}`），模型目录不携带代码；
- 音频走临时 WAV（首版约定；无 torchaudio）；
- 权重读取一律 `weights_only=True`。

### 阶段 2：Rust 子进程 adapter ✅ 已完成

- `inference/pytorch.rs`：长驻 worker 客户端（懒启动、JSON 行 IPC、请求超时、
  崩溃自动重启、stderr 尾部诊断、PID、Drop 回收）；
- `inference/pytorch_asr.rs`：`PyTorchAsrAdapter` 实现 `AsrEngine`；
- `tts/engine/pytorch.rs`：`PyTorchTtsEngine` 实现 `TtsEngine`；
- 两个注册表各注册一行；调用方无 PyTorch 专用分支。

### 阶段 3：运行时下载接入 ✅ 已完成

见 §4.6 / §4.9。

### 阶段 4：模型接入 ✅ 已完成（首个模型）

- `BackendSpec::PyTorch` + `FileRole::Extra` + `model_manager::FRAMEWORKS` 的 pytorch 行；
- 两个真实模型（HF 直链、revision 钉 commit）：Whisper-tiny（ASR）、Kokoro-82M（TTS）；
- 端到端实测（走生产路径：注册表 → adapter → worker → 真实推理）：

```text
[e2e] whisper-tiny 转写: "今天下午3點我們再會議是開會討論項目進度"
[e2e] kokoro 合成 120000 样本 @24000Hz 峰值 11947
```

### 阶段 5：验证和发布 🟡 部分完成

已覆盖：

- worker 超时 / 进程秒退 / 协议版本不符三条监督路径（假 worker + 真解释器）；
- 适配器白名单拒绝未知 id、未加载时给出可读错误；
- CPU 运行时可用；CUDA 运行时可用（本机 `cuda_available=true`）；
- 缺运行时时的可读失败（不做兜底猜测）；
- 语言门禁：单语 TTS 模型拒绝其它语言。

未覆盖（需要图形界面/真机）：

- 在**无系统 Python 的干净 Windows 机器**上跑一遍（当前仅开发机验证）；
- 无 NVIDIA 驱动的机器上 CUDA 包的 `cuda_available=false` 降级行为；
- 便携模式与安装模式的路径差异；
- 图形界面里的模型页/框架页交互回归。

---

## 12. 不变约束

1. PyTorch 不进入 VoxFlow 主程序的默认安装包；
2. 用户未选择 PyTorch 时不下载 Python/PyTorch；
3. 不依赖用户系统 Python 或 pip；
4. 不在用户机器执行 `pip install`；
5. 不把 PyTorch native DLL 加载进 VoxFlow 主进程；
6. 推理框架必须通过独立进程隔离；
7. 运行时和模型分开管理；
8. 版本、SHA-256、架构和协议必须可追踪；
9. 新增框架通过 registry 和数据描述符接入；
10. 不默认执行远程模型目录中的任意 Python 代码。

---

## 13. 参考资料

- [PyTorch C++ API overview](https://docs.pytorch.org/docs/stable/cpp_index.html)
- [Installing C++ Distributions of PyTorch / LibTorch](https://docs.pytorch.org/cppdocs/installing.html)
- [PyTorch Start Locally](https://pytorch.org/get-started/locally/)
- [PyTorch wheel index](https://download.pytorch.org/whl/)
- [Python Windows embeddable distribution](https://docs.python.org/3/using/windows.html#embedded-distribution)
- [Python Windows downloads](https://www.python.org/downloads/windows/)
- [tch-rs](https://github.com/LaurentMazare/tch-rs)
- [tch crate documentation](https://docs.rs/crate/tch/latest)
- [VoxFlow inference architecture baseline](./推理引擎架构重构方案.md)
