> From: https://gemini.google.com/app/0e75588d70c94faf

# you asked

message time: 2026-08-22 10:11:21

CapsWriter-Offline 我想开发这样的软件，将内置 支持Qwen3-ASR的py框架,应该用 Electron,还是用tauri

---

# gemini response

CapsWriter-Offline 核心的体验在于**极低的内存/CPU占用**以及**极其轻量的常驻状态**，配合快捷键唤起和实时流式上屏。

开发支持 **Qwen3-ASR** 的类似软件，推荐选择 **Tauri (v2)**。

---

### 选型对比

| 维度 | Tauri (v2) | Electron |
| :--- | :--- | :--- |
| **内存占用** | **低（~30-50MB）** | 高（自带 Chromium 进程，150MB+） |
| **体积包大小** | **极小（< 15MB）** | 较大（> 80MB） |
| **系统托盘与全局快捷键** | **Rust 原生支持**（极低延迟，响应迅速） | Node.js 插件层支持，偶有卡顿 |
| **Python ASR 协作模式** | Sidecar 独立进程 / WebSocket 管道 | Child Process 开启子进程 |

---

### 为什么 Tauri 更适合这个项目

1. **核心定位相符**：CapsWriter 类软件通常需要开机自启并长时间常驻后台。Electron 仅仅空载 UI 就会占用较多内存，而 Tauri 的前端渲染依托于系统自带 WebView2，前端开销极小。
2. **Qwen3-ASR 的权重特点**：Qwen3-ASR（即便 0.6B 版本）在推理时对 PyTorch、CUDA 或 CPU/VRAM 资源已有一定要求。在主程序上使用 Tauri 节省系统内存，能将更多资源留给 Python 端模型推理。
3. **Rust 系统级API**：CapsWriter 需要监听键盘全局热键（按下录音、松开识别）、模拟文本粘贴（上屏）以及挂载系统托盘。Rust 拥有强大的系统级原生库（如 `global-hotkey`、`enigo`），在后台监听和自动化上屏表现出色。

---

### 推荐的架构设计方案

Qwen3-ASR 依赖 PyTorch 和 `qwen-asr` 环境，完全打包进 C++ 或 Rust 难度较大，因此最稳妥且易维护的架构是 **“Tauri (Rust主控) + Python (推理后端 Sidecar)”**：

```
+--------------------------------------------------------+
|                     Tauri App                          |
|  +--------------------+      +----------------------+  |
|  | 前端 UI (Vue / React)|      |  Rust 主进程          |  |
|  | (设置界面/悬浮条)    | <--> |  - 全局快捷键监听    |  |
|  +--------------------+      |  - 系统剪贴板/模拟打字|  |
|                              +----------+-----------+  |
+-----------------------------------------|--------------+
                                          | WebSocket / IPC
                                          v
                              +-----------------------+
                              | Python Sidecar 进程    |
                              | - Qwen3-ASR 推理引擎   |
                              | - PyTorch / vLLM   |
                              | - VAD 麦克风音频流捕捉 |
                              +-----------------------+
```

1. **后端 (Python Sidecar)**：
   * 将 Python 环境打包为独立 Executable，或者在应用启动时拉起独立的环境进程。
   * 使用 `sounddevice` 采集麦克风音频，结合 VAD（语音活动检测）截取片段，调用 Qwen3-ASR 进行流式或单次识别。
   * 识别结果通过本地 WebSocket / Pipe 实时推送到 Rust 主进程。
2. **主控 (Tauri / Rust)**：
   * 负责管理 Python Sidecar 进程的生命周期（随应用启动/关闭）。
   * 捕获全局长按/单击快捷键。
   * 收到 Python 端识别到的文本后，自动写入剪贴板并模拟 `Ctrl+V` 将文字上屏到当前焦点输入框。
3. **前端 (UI)**：
   * 仅用于配置参数（如模型路径、GPU/CPU 切换、快捷键设置）以及展示识别状态悬浮条。

---

### Python 打包建议

Qwen3-ASR 包含了完整的模型架构和推理依赖。在打包 Sidecar 时：
* 如果定位是**便携绿色版**：使用 `PyInstaller` 或 `Nuitka` 将 Python 脚本打成单个 Executable 文件；或者随包附带一个极简的嵌入式 Python 环境（Embedded Python），通过 Tauri 的 `externalBin` / `resources` 配置打包。
* 如果定位是**开发者/极客工具**：直接让 Rust 检查系统 Python 环境或特定的 Conda 环境/虚拟环境，通过命令行拉起 Python 服务脚本，减轻安装包体积。

---

对于这类轻量级常驻工具，Tauri (v2) 具备明显的性能和体验优势。

[Tauri With External Binary (Sidecar)](https://www.youtube.com/watch?v=dMJKXUFxD0Y)
该视频详细展示了如何在 Tauri 中配置并启动 Sidecar 独立二进制进程（例如打包好的 Python 服务），以及如何通过通信接口在前端/Rust 与 Backend 之间传输数据，对构建此架构非常有参考价值。

---

# you asked

message time: 2026-08-22 10:12:38

我不想前后端分离，我想打包成一个桌面软件,俺姐之前用Tauri  好像碰到渲染性能问题，是吗？

---

# gemini response

关于你提到的**“渲染性能问题”**以及**“不想前后端分离，想直接打包成一个桌面软件”**，这里需要先厘清两个核心关键：

---

### 一、 你姐姐碰到的“Tauri 渲染性能问题”是怎么回事？

Tauri 本身不捆绑 Chromium，而是直接调用**操作系统自带的 WebView**（Windows 上是 WebView2/Edge 内核，macOS 上是 WebKit/Safari 内核）。

<Image alt="Tauri 架构流程图" caption="Tauri 架构原理：通过 Core 调度系统原生 WebView" src="image_agent_tag_3498980439012300487"/>

大家常说的“Tauri 渲染性能问题”或“坑”，通常集中在以下几种场景：

1. **跨平台渲染不一致与兼容性**：
   * **Electron** 打包了完整的 Chromium，在所有机器上渲染引擎版本完全一致，性能极其可预测。
   * **Tauri** 在 Windows 上用 WebView2，性能和 Chrome 差异不大；但在 macOS/Linux 上用的是 WebKit，在复杂 CSS 动画、Canvas 绘图或特定 3D 渲染时，WebKit 的优化和硬件加速策略可能不如 Chromium，容易出现帧率抖动或渲染微小差异。
2. **IPC（进程间通信）频次过高**：
   * 如果在前端频繁（如每毫秒）通过 Tauri 的 `invoke` 或事件通道向 Rust 传输海量数据（例如音频原始波形数据），序列化/反序列化（JSON/MessagePack）会拖慢 UI 渲染，导致界面卡顿。

**对于 CapsWriter 类型的语音工具：**
CapsWriter 的界面绝大部分时间是一个极简的**小悬浮条**或**托盘菜单**，没有任何重度 Canvas/3D/复杂 DOM 渲染。因此在 CapsWriter 这类场景下，Tauri 的 WebView 渲染性能完全足够，不会构成瓶颈。

---

### 二、 不想“前后端分离”，只想打包成一个桌面软件？

如果你的意思是**“不想开两个进程/不想搞 REST API 或 WebSocket 通信，只想用全套 Python 或纯单体方案来写 GUI 并打包”**：

**1. Tauri / Electron 无法避免进程分离**
* 因为 Qwen3-ASR 依赖 Python 生态（PyTorch / ONNX Runtime 等），而 Tauri (Rust) 和 Electron (Node.js) 的主进程都不是 Python。
* 如果强制使用 Tauri/Electron，Python 必须作为一个独立的 Backend/Sidecar 进程运行，无法做到代码级的“单体融为一体”。

**2. 纯 Python 单体 GUI 方案（推荐 PySide6 / PyQt6）**
如果你希望**代码全部用 Python 写，界面和语音识别逻辑写在同一个项目里，最后用 PyInstaller 一键打包成单一 `.exe` 或绿色文件夹**，最成熟的选择是 **PySide6 (Qt for Python)**。

* **真正的单体**：界面（Qt）和 Qwen3-ASR 逻辑都在同一个 Python 运行时中，直接通过 Python 线程/异步队列通信，不需要处理 IPC 接口或 HTTP 服务。
* **常驻与快捷键支持**：PySide6 结合 `pynput` 或 `keyboard` 库，可以轻松实现全局快捷键监听、无边框透明悬浮条、系统托盘。
* **原生渲染**：Qt 使用 C++ 原生控件或 QML 渲染，不需要浏览器内核，内存占用通常在 100MB 左右（远低于 Electron，略高于 Tauri），且完全没有 WebView 渲染卡顿的问题。

---

### 选型建议

| 需求侧重 | 推荐技术栈 | 架构形态 |
| :--- | :--- | :--- |
| **纯 Python 开发，拒绝跨语言通信** | **PySide6 (Qt) + Qwen3-ASR** | **单进程单体**，直接用 PyInstaller 打包为单个程序 |
| **追求极致小巧常驻，不介意 Python 做后台** | **Tauri (v2) + Python Sidecar** | **双进程协同**，Rust 管 UI 和快捷键，Python 管 AI 推理 |
| **界面极度复杂，需要丰富 Web 生态** | **Electron + Python Sidecar** | **双进程协同**，兼容性最好，但内存开销较大 |

如果希望极简开发、拒绝 IPC 协议对接，直接选择 **PySide6** 配合 PyInstaller 打包是当下最顺畅的方案。

---

# you asked

message time: 2026-08-22 10:16:01

界面肯定还是要些东西的,既然双进程内存开销已经大了,那么用Electron 也没有关系了,Electron 也就多个100多兆的内存,再加上Python 的内存，300~400兆的内存,还是说，虽然Python 需要单独进程，但是Tauri 可以把它打成一个便携版的包,不用安装，打包在一起

---

# gemini response

你的理解非常准确！这里有两个非常核心的点需要拆解：

---

### 一、 关于“便携版单文件/打包在一起”
**无论是 Tauri 还是 Electron，都可以把 Python 后端打包进同一个程序包中，实现“解压即用”或“单文件/单安装包”，完全不需要用户另外安装 Python 环境。**

在打包方案上，两者的实现逻辑是一致的：
1. **嵌入式 Python (Embedded Python) / PyInstaller 打包**：
   你先将包含 Qwen3-ASR 推理代码及 PyTorch/ONNX 等依赖的 Python 环境，通过 PyInstaller、Nuitka 打包成一个独立的 `.exe`（或包含 dll 的文件夹）。
2. **打入主程序 Resource/Sidecar**：
   * **Tauri**：支持 `sidecar` 功能，在 `tauri.conf.json` 中配置外部二进制文件（externalBin），打包时会自动将这个 Python 执行文件打包进同一个安装包（或免安装 Zip 压缩包）。
   * **Electron**：利用 `extraResources` 或 `extraFiles`，把 Python 打包出的目录/程序放进 Electron 的资源文件夹中。
3. **运行时无感拉起**：
   桌面软件启动时，Tauri（Rust）或 Electron（Node.js）会自动在后台拉起这个内置的 Python 进程；软件关闭时，自动杀掉 Python 进程。**对最终用户来说，就是一个独立的 `.exe` 桌面软件，完全不需要关心后台还有 Python 在跑。**

---

### 二、 为什么如果不在乎这 100~200MB 内存，Electron 是极其稳妥的选择？

你说的**“既然已经有 Python 这个内存大头，Electron 多的 100 多兆完全可以接受”**，这个思路在工业界开发中非常现实且合理。

1. **兼容性与开发体验极其成熟**
   * **跨平台渲染一致性**：Electron 自带独立的 Chromium，无论在 Windows 10/11、老旧电脑还是 macOS 上，UI 渲染结果、CSS 表现、字体绘制完全一模一样，不会出现 Tauri 依赖系统 WebView2 带来的样式错位或硬件加速异常。
   * **生态庞大**：前端有大量成熟的 UI 组件库（Element Plus、Ant Design、Tailwind CSS、Shadcn UI 等），做复杂界面、设置面板、历史记录列表、历史文本编辑非常快速。
2. **进程间通信（IPC）与 Node.js 生态**
   * 在 Electron 里，Node.js 可以直接用 `child_process.spawn` 拉起内置的 Python 进程，通过 `stdio`（标准输入输出）或者本地 WebSocket 进行通信，写起来比 Rust 简单很多。
   * Electron 社区有非常成熟的全局快捷键（`globalShortcut`）、系统托盘（`Tray`）、剪贴板操作（`clipboard`）等 API，踩坑概率远低于 Tauri。

---

### 三、 Electron + Python 打包最佳实践

如果你决定采用 Electron 方案，推荐的目录与打包架构如下：

```text
my-caps-writer/
├── src/                    # Web 前端界面 (Vue 3 / React / Svelte)
├── electron/               # Electron 主进程代码 (Main Process)
│   ├── main.js             # 控制窗口、托盘、全局快捷键
│   └── python-manager.js   # 负责拉起/管理后台 Python 进程
├── python-backend/         # Python Qwen3-ASR 识别后端
│   ├── app.py              # 服务入口 (如基于 FastApi / WebSocket / stdin)
│   └── requirements.txt
└── package.json            # electron-builder 打包配置
```

**打包流程关键点：**
1. 在 build 阶段，先用 `PyInstaller` 将 `python-backend` 编译为可执行目录 `python-dist/`。
2. 配置 `electron-builder`：
   ```json
   "build": {
     "extraResources": [
       {
         "from": "python-dist/",
         "to": "python-engine/"
       }
     ]
   }
   ```
3. 在 Electron 的 `main.js` 中获取内置路径并拉起：
   ```javascript
   const { app } = require('electron');
   const path = require('path');
   const { spawn } = require('child_process');

   // 获取打包后的资源路径
   const pythonExecutable = app.isPackaged
     ? path.join(process.resourcesPath, 'python-engine', 'app.exe')
     : path.join(__dirname, '../python-backend/dist/app.exe');

   const pythonProcess = spawn(pythonExecutable);
   ```

---

### 总结建议

如果你希望**界面丰富、开发速度快、不用折腾 Rust，并且不计较额外的 ~150MB 内存**：
👉 **直接选 Electron + Python Sidecar**，把 Python 环境通过 `extraResources` 打包进同一个便携压缩包/安装包即可，这是目前商业和开源应用中最成熟、最不易踩坑的架构方案。

---

# you asked

message time: 2026-08-22 10:18:55

我的意思是，虽然是双进程，但是Electron  没法打成一个exe 文件，它必须是一个文件夹，而 tauri 可以打包出一个 portable.exe，虽然是双金属，但是它能打包出一个文件来，也不用安装，直接点击就运行，我的理解对吗？

---

# gemini response

你的理解**非常到位**！你准确抓住了 Electron 和 Tauri 在打包形态上的一个非常关键的区别。

### 1. 关于“单文件便携版 (Portable.exe)”的对比

* **Tauri (v2)**：
  * **完全正确**。Tauri 原生支持生成真正的 **Portable 单文件 `.exe`**。
  * 即使项目里包含了 Python Sidecar（打好的独立 `.exe` 或依赖资源），Tauri 的打包工具（`tauri-bundler`）也可以把主程序、UI 静态资源、以及你的 Python 引擎**统一压缩打包进一个单独的 `.exe` 文件中**。
  * **运行原理**：用户双击这个单文件 `portable.exe` 时，它会在后台自动解压临时资源并启动，无需安装、解压后也不会留下垃圾，关闭后即走，体验非常纯粹。
* **Electron**：
  * Electron 的官方和 mainstream 架构**确实必须是一个文件夹**（包含 `main.exe`、几十个 `.dll` 动态链接库以及 `resources/app.asar` 资源文件）。
  * 虽然用 7-Zip 自解压模块或者 `electron-builder` 的 portable 模式也可以强行包装成一个 `.exe`，但那个单文件**体积极大**（通常 150MB+），且每次双击都要把整个 100 多兆的 Chromium 解压到 `%TEMP%` 临时目录，**启动会有明显的几秒延迟和硬盘读写卡顿**。

---

### 2. 为什么你的这个需求，Tauri + Python 完美胜任？

对于 CapsWriter 这类**“即开即用、随时唤起、注重便携”**的工具：

1. **体积与启动速度**：
   * Tauri 的主程序主体只有十几 MB，将 Python 推理引擎（如 ONNX/PyTorch 裁剪后的运行环境）打包进去后，整体体积被控制得很好。
   * 单文件启动时，Tauri 释放和拉起主界面的速度远快于 Electron，几乎是毫秒级响应。
2. **纯粹的“单文件”便携体验**：
   * 你只需要把 `tauri.conf.json` 里的 `externalBin` 指向你用 PyInstaller/Nuitka 编译好的 Python 后端 `.exe`。
   * 执行 `tauri build`，它就会直接在 `target/release/bundle/portable/` 下吐出一个独立的 `.exe`。
   * 无论放 U 盘里还是发给别人，都是**单一文件，点开即用**。

---

### 3. 架构落地关键细节建议

如果你准备采用 **Tauri (v2) 打包 Python Sidecar 单文件 `.exe`**，开发时注意以下两点：

1. **Python 后端打包为单个可执行文件**：
   * 在整合到 Tauri 之前，先用 PyInstaller 将 Python 项目打包成 `-F` (onedir 也可以，但 onefile 在 Sidecar 整合时更干净) 模式：
     `pyinstaller --onefile --name qwen-asr-engine app.py`
2. **Tauri 配置文件声明 Sidecar**：
   * 在 `src-tauri/tauri.conf.json` 中配置：
     ```json
     {
       "bundle": {
         "externalBin": [
           "binaries/qwen-asr-engine"
         ]
       }
     }
     ```
   * 在 Rust 主进程里直接使用 Tauri 的 `Command::sidecar("qwen-asr-engine")` 即可一键无感拉起。

**总结**：你的理解完全正确！**想做“单文件免安装、解压即用、独立 Portable.exe”**，Tauri 是比 Electron 优秀得多的选择。

---

# you asked

message time: 2026-08-22 10:20:31

性能方面有差别吗？和安装版？对比Electron 性能呢？

---

# gemini response

在性能和打包形态上，**“单文件/Portable”** 与 **“安装版”**、以及 **Tauri** 与 **Electron** 之间存在非常明确的性能差异。

---

### 一、 单文件 Portable 版 vs 安装版（性能有区别吗？）

#### 1. Tauri 框架：**无性能差别，但有首启动和释放机制的区别**
* **运行期性能（CPU/内存/推理速度）：完全没有区别。** 软件启动后，内存里的代码和 GPU 推理逻辑是 100% 相同的，识别语音的速度也完全一样。
* **启动速度差异（首次 vs 后续）：**
  * **Portable.exe（单文件）**：首次双击时，Tauri 会在后台静默将打包在内部的资源和 Python Sidecar 解压到系统 `%TEMP%` 临时目录，然后再拉起进程。首次启动会有几十到几百毫秒的释放延迟。
  * **安装版**：安装时就已经把文件解压到了 `AppData` 或 `Program Files` 目录下，每次双击是直接读取硬盘文件，**启动稍快一点点**。

#### 2. Electron 框架：**Portable 版会有非常明显的“卡顿感”**
* **极其不推荐 Electron 做 Portable 单文件**：Electron 的单文件 Portable 主要是用 7-Zip 或自解压模块打包的。由于它捆绑了整个 Chromium 浏览器（上百兆），**每次双击运行，都要把 100~200MB 的 Chromium 解压一遍**。
* 这会导致 Electron 的单文件版每次启动都有 **2~5 秒的硬盘高读写和明显延迟**，体验远不如安装版。

---

### 二、 Tauri vs Electron：核心性能对比

假设都在“运行时”（不论安装版还是绿色 Portable 版），两者的性能表现对比：

| 性能/体验维度 | Tauri (v2) | Electron | 影响解析（对 CapsWriter 类应用） |
| :--- | :--- | :--- | :--- |
| **应用冷启动速度** | **< 200 ms (极快)** | **1.5 ~ 3 秒 (偏慢)** | **Tauri 大胜**。CapsWriter 需要随叫随到，Tauri 启动几乎是秒开。 |
| **界面 UI 渲染性能** | 依靠系统 WebView2 (Edge内核) | 自带完整 Chromium | **基本平手**。在 Windows 上，WebView2 本质也是 Chrome 内核，渲染轻量界面没有性能差距。 |
| **内存占用 (UI层)** | **30 MB ~ 50 MB** | **150 MB ~ 300 MB** | **Tauri 占优**。加上 Python 推理后端后：Tauri 全家桶约 **200~300MB**，Electron 全家桶约 **400~500MB**。 |
| **打包文件体积** | **极小 (10~20MB)** | **较大 (80~150MB)** | 不算 Python 模型的情况下，Tauri 的体积小得多。 |
| **跨进程 IPC 通信** | Rust 与 Python 管道通信 | Node.js 与 Python 通信 | 识别结果上屏（传递字符串）数据量极小，性能完全没有瓶颈。 |

---

### 三、 总结与最佳决策建议

1. **如果你的诉求是“不做安装包，只发一个 `CapsWriter.exe` 给别人，点开就能用”**：
   * **强烈选择 Tauri**。Tauri 的 Single-executable（单文件打包）是原生支持且非常轻量级的，启动释放速度快，不卡顿。
   * 不要用 Electron 做真正的“单文件 Portable”，体验会非常槽糕（启动解压太慢）。
2. **性能结论**：
   * 在 **Qwen3-ASR 语音识别速度**（GPU/CPU 推理）上，Tauri 和 Electron **完全一致**，因为推理工作全都在 Python 端。
   * 在 **软件响应速度、开机常驻内存占用、双击启动速度** 上，**Tauri 完胜 Electron**。

因此，对于支持 Qwen3-ASR 的**免安装单文件绿色版语音工具**，**Tauri + Python Sidecar** 在性能、体积和便携度上都是目前最优的组合。

---

# you asked

message time: 2026-08-22 10:22:10

我计划，软件开发完了，也对外提供一个标准的 TTS，接口，嗯，支持标准接口的都可以调用，进行语音识别

---

# gemini response

如果要对外暴露标准的接口供其他第三方软件（如 Chatbox、Cherry Studio、SillyTavern、Obsidian 插件等）直接调用，**非常建议做成 OpenAI 标准兼容的语音识别（ASR）接口**。

*注：虽然你提到“标准的 TTS 接口”，但考虑到软件的核心逻辑是 Qwen3-ASR（语音转文字），你实际需要暴露的是 **ASR / Speech-to-Text (STT) 接口**。*

---

### 一、 推荐的标准接口规范：OpenAI Audio Transcriptions

目前开源社区和主流客户端最通用、兼容性最好的 ASR 接口是 **OpenAI API Specification** 的 `POST /v1/audio/transcriptions`。只要你实现了这个 HTTP 端点，绝大多数支持 AI 语音输入的客户端无需任何特殊适配，直接填写你的本地地址（如 `[http://127.0.0.1](http://127.0.0.1):端口/v1`）就能直接使用。

#### 1. 接口定义
* **URL**: `POST /v1/audio/transcriptions`
* **Header**: `Content-Type: multipart/form-data`
* **Form Data 请求参数**：
  * `file`: 音频文件（支持 `.wav`, `.mp3`, `.m4a`, `.ogg`, `.flac` 等）
  * `model`: 模型名称（如字符串 `"qwen3-asr"`，可忽略或用于路由）
  * `language`: 语言代码（可选，如 `"zh"`, `"en"`）
  * `response_format`: 返回格式，默认为 `"json"`，有时客户端会请求 `"text"` 或 `"verbose_json"`

#### 2. 标准 JSON 返回值结构
客户端请求 `response_format=json` 时，你只需要返回极其简单的一个 JSON：

```json
{
  "text": "这里是 Qwen3-ASR 识别出来的最终文本内容。"
}
```

---

### 二、 架构与代码实现方案 (Python FastAPI)

在你的 **Python Sidecar 后端**中，使用 `FastAPI` + `uvicorn` 可以极其轻松地搭建这个 HTTP 服务。

#### 核心实现示例：

```python
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import io

app = FastAPI(title="Qwen3-ASR OpenAI Compatible API")

# 允许跨域，方便 Web 前端或各种 Client 调用
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form("qwen3-asr"),
    language: str = Form(None),
    response_format: str = Form("json")
):
    try:
        # 1. 读取上传的音频文件字节流
        audio_bytes = await file.read()
        
        # 2. 调用你的 Qwen3-ASR 推理逻辑
        # recognized_text = run_qwen3_asr_inference(audio_bytes, language)
        recognized_text = "这是测试识别结果"  # 替换为实际推理输出
        
        # 3. 按照 response_format 格式化返回
        if response_format == "text":
            return recognized_text
        
        # 默认返回 OpenAI 标准 json 格式
        return {"text": recognized_text}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    # 本地监听指定端口，支持对外提供服务
    uvicorn.run(app, host="127.0.0.1", port=9870)
```

---

### 三、 进阶选配：如果确实需要真正的 TTS（文字转语音）接口

如果后续计划扩展**朗读文本（Text-to-Speech）**功能，同样推荐实现 OpenAI 的 `POST /v1/audio/speech` 标准接口：

* **请求**: `POST /v1/audio/speech`
* **JSON Body**:
  ```json
  {
    "model": "qwen-tts",
    "input": "需要朗读的文本",
    "voice": "default"
  }
  ```
* **返回**: 直接返回音频二进制数据数据流（`audio/mpeg` 或 `audio/wav`）。

---

### 四、 设计上的注意事项

1. **端口与 API Key**：
   * 可以在软件设置界面提供一个 **“开启 API 服务”** 开关，并允许用户自定义**服务端口**（例如默认 `9870`）。
   * 建议支持设置一个可选的 `API Key`，防止局域网内其他设备未经过授权随意调用本地 GPU 算力。
2. **多线程/并发推理处理**：
   * Qwen3-ASR 推理会占用显卡/CPU，如果多个软件同时调用该接口，建议在 Python 端加上并发锁（`asyncio.Lock()` 或 `queue`），避免显存溢出（OOM）或推理冲突。
3. **音频格式兼容**：
   * 第三方客户端上传的音频格式五花八门（`.wav`, `.ogg`, `.webm`, `.m4a`）。建议在 Python Sidecar 中集成 `pydub` 或 `ffmpeg-python`，在送入模型前统一转码为 Qwen3-ASR 最喜爱的采样率（如 16kHz 单声道 WAV）。

---

# you asked

message time: 2026-08-22 10:23:26

你的意思直接在 Python 中实现这个接口，而不是说用 Rust 的后面再重新实现这个接口？

---

# gemini response

**是的，完全正确！强烈建议直接在 Python 中实现这个 API 接口，而不是用 Rust 重新写一遍转发层。**

这样设计在架构上有极大的优势：

---

### 为什么应该直接在 Python 中实现？

1. **避免二次传输与性能损耗（零中间商）**
   如果用 Rust 来提供 HTTP 接口，当第三方客户端发送一个 10MB 的音频文件时，流程会变成：
   `第三方客户端 -> (HTTP上传) -> Rust -> (IPC/Pipe跨进程传输) -> Python`
   不仅增加了 Rust 端的反序列化开销，还多了一次跨进程大文件/字节流传输。
   **而直接在 Python 端（FastAPI/Uvicorn）监听 HTTP 端口**，第三方音频直接一步到位进入 Python 内存，拿去跑 Qwen3-ASR 推理，效率最高。

2. **开发成本极低**
   * Python 生态里有 **FastAPI** / **Sanic** 等极其成熟且高性能的 Web 框架，配合 `pydantic`，几行代码就能写出完全符合 OpenAI 规范的 API 端点。
   * 如果用 Rust 重新实现，你不仅要在 Rust 里用 `axum` 或 `actix-web` 写一套 HTTP 服务，还要在 Rust 和 Python 之间设计一套专门的 IPC 协议，相当于把简单问题复杂化了。

3. **Tauri 与 Python 的职责分工更清晰**
   在这个架构下，两者的定位非常纯粹：

```
+-----------------------------------------------------------------+
|                         你的桌面客户端                          |
|                                                                 |
|   +-------------------+            +------------------------+   |
|   | Tauri (Rust 主控)  |            | Python Sidecar (后端)  |   |
|   | - 监听本地快捷键   |            | - Qwen3-ASR 模型推理   |   |
|   | - 麦克风实时录音   | --WebSocket-> - 麦克风流式识别上屏   |   |
|   | - 模拟键盘粘贴上屏 | (本地内部通信) |                        |   |
|   +-------------------+            | - FastAPI 服务 (9870)  |   |
|                                    +-----------+------------+   |
+------------------------------------------------|----------------+
                                                 |
                                     标准的 HTTP OpenAI API
                                     (POST /v1/audio/transcriptions)
                                                 |
                                     +-----------v------------+
                                     |  第三方软件 (外部调用) |
                                     | (Chatbox / Obsidian等) |
                                     +------------------------+
```

* **Tauri (Rust)**：只负责**客户端本体**的操作（托盘、快捷键、系统剪贴板/打字模拟、设置界面）。
* **Python (Sidecar)**：负责**所有与 AI/语音相关的事务**。它既服务于 Tauri（通过本地 WebSocket 接收快捷键录音），又对外暴露标准的 HTTP 接口服务于第三方软件。

---

### Python 端处理两套输入的逻辑

在 Python Sidecar 中，你的 Qwen3-ASR 模型引擎只需要初始化一次，然后同时暴露给两个入口：

```python
# app.py (Python Sidecar)
import asyncio
from fastapi import FastAPI, UploadFile, File
import uvicorn

app = FastAPI()

# 共享的模型单例
asr_engine = LoadQwen3ASRModel()

# 入口 1：服务于本地 Tauri 客户端（实时录音/快捷键上屏）
@app.websocket("/ws/live-asr")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    while True:
        audio_chunk = await websocket.receive_bytes()
        text = asr_engine.recognize(audio_chunk)
        await websocket.send_text(text)

# 入口 2：对外暴露的标准 OpenAI ASR 接口（服务于第三方软件）
@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...)):
    audio_bytes = await file.read()
    text = asr_engine.recognize(audio_bytes)
    return {"text": text}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=9870)
```

这样既省去了 Rust 端的重复开发，又保证了推理逻辑的集约管理，是性价比最高的实现方式。

---

# you asked

message time: 2026-08-22 10:24:58

这样，配置里面是不是要引入一个web包？体积会更加增大,然后在 Ras 的里面能控制这个接口的端口和地址,然后在rust界面可以点击启动？

---

# gemini response

这三个问题非常懂行，完全切中了桌面端和后台进程结合时的核心痛点。

针对你的疑问，答案是**完全可以实现，而且体积增加可以忽略不计**。下面为你详细拆解具体的实现思路：

### 一、 引入 Web 包会导致体积大幅增加吗？
**结论：影响极小，几乎可以忽略。**

* **对比悬殊**：你的 Python 环境里已经有了 PyTorch、ONNX Runtime 或者类似重型 AI 推理库，再加上 Qwen3-ASR 的模型权重，整体体积至少是几百兆起步。
* **Web 框架的体积**：引入 `FastAPI` 和 `Uvicorn`，在经过 PyInstaller 打包（会剔除无用代码）后，最终的 `.exe` 也就仅仅**增加 5MB ~ 10MB** 左右。为了获得极其稳定、标准化的接口服务，这几兆的空间换取开发效率是完全值得的。

---

### 二、 如何在 Rust 界面控制端口、地址并动态启停？

你肯定**不希望**每次点击“启动/关闭接口”时，都把整个 Python 进程杀掉重启——因为重新加载 Qwen3-ASR 模型需要好几秒甚至十几秒，体验很差。

最佳方案是：**模型推理常驻内存，HTTP 服务动态启停。**

可以通过 **Tauri (Rust) -> 进程标准输入 (stdin) -> Python** 的方式来控制。

#### 1. Python 端的实现（核心思路：子线程跑 Web 服务）
Python 进程一启动，就加载模型并监听按键（或 WebSocket）。同时，后台开一个专门的线程用于运行 FastAPI。当收到 Rust 传来的指令时，启停这个 Web 服务。

```python
import sys
import json
import threading
import uvicorn
from fastapi import FastAPI

app = FastAPI()
api_server = None

@app.post("/v1/audio/transcriptions")
def transcribe():
    return {"text": "模型识别结果"}

def run_server(host, port):
    global api_server
    config = uvicorn.Config(app, host=host, port=port)
    api_server = uvicorn.Server(config)
    api_server.run()

# 监听 Rust 传来的指令
for line in sys.stdin:
    command = json.loads(line.strip())
    
    if command["action"] == "start_api":
        # Rust 界面点击“启动 API”
        host = command.get("host", "127.0.0.1")
        port = command.get("port", 9870)
        threading.Thread(target=run_server, args=(host, port), daemon=True).start()
        print(json.dumps({"status": "API_STARTED", "port": port}))
        
    elif command["action"] == "stop_api":
        # Rust 界面点击“关闭 API”
        if api_server:
            api_server.should_exit = True
            print(json.dumps({"status": "API_STOPPED"}))
```

#### 2. Rust (Tauri) 端的控制
在 Tauri 界面，你可以设计一个表单让用户输入 `127.0.0.1` 和 `9870`，然后通过按钮触发 Rust 函数。Rust 通过向正在运行的 Sidecar 进程发送 JSON 字符串来控制 API。

```rust
use tauri::api::process::{Command, CommandEvent};

// 全局保存 Python 进程的发送管道 (Sender)
// ...

#[tauri::command]
fn start_api_server(host: String, port: u16) {
    // 构建指令
    let cmd = serde_json::json!({
        "action": "start_api",
        "host": host,
        "port": port
    });
    
    // 通过标准输入管道 (stdin) 发送给 Python Sidecar
    python_stdin_sender.write(cmd.to_string().as_bytes());
}

#[tauri::command]
fn stop_api_server() {
    let cmd = serde_json::json!({ "action": "stop_api" });
    python_stdin_sender.write(cmd.to_string().as_bytes());
}
```

### 总结工作流
1. **软件启动**：Tauri 静默拉起 Python Sidecar，Python 加载模型，准备就绪。
2. **日常使用**：用户按全局快捷键，直接调用 Python 里的模型进行语音打字。此时不开启任何网络端口，零安全风险。
3. **接口调用**：用户在 Tauri 界面修改了端口，点击**“启动对外 API”**。Rust 将参数打包成 JSON 喂给 Python。Python 内部拉起 Uvicorn 服务。此时外部软件（如 Chatbox）就能顺利接入你的本地语音识别了。

---

# you asked

message time: 2026-08-22 10:27:11

我问个问题，既然 Python 都提供接口服务了，那么，Rust 的还有必要用进程通信和 Python 去沟通？哪个效率高一点？还是说，最开始只有进程沟通，只有你点击启动的时候才会启动标准接口，标准接口不是经常启动的

---

# gemini response

你思考得**极其精准**，直接点破了**进程间通信（IPC）与 Web 网络协议**在性能和架构上的本质差异！

---

### 一、 哪个效率高？（IPC 管道 vs Web 接口）

**IPC 管道通信（Standard I/O / Pipe）效率远高于 Web 接口。**

#### 性能对比

| 维度 | 本地 IPC (Stdin/Stdout 管道 或 Unix Domain Socket) | 本地 HTTP Web 接口 (FastAPI / Uvicorn) |
| :--- | :--- | :--- |
| **通信开销** | **极低（微秒级 $\le 0.1\text{ms}$）** | **较高（毫秒级 $1 \sim 5\text{ms}$）** |
| **协议层** | 纯原始字节流/JSON 字符串，无额外包头 | 需处理 TCP 三次握手、HTTP 报头解析、Keep-Alive 维护等 |
| **操作系统开销** | 内存级别的管道缓冲，不经过网络协议栈 | 必须走 loopback 网络协议栈（`127.0.0.1`），触发防火墙检查 |
| **适用场景** | **主程序与后台子进程的高频、实时交互**（如实时录音打字） | **跨程序/跨语言的标准服务提供** |

---

### 二、 为什么不能只用 Web 接口？

如果你想“图省事”，让 Rust 也去调用 Python 提供的 HTTP 接口，在 CapsWriter 这种**实时打字/录音**场景下，会引入三个致命痛点：

1. **响应延迟与流式上屏的流畅度**：
   * CapsWriter 核心体验在于：按下快捷键录音，说话的同时文字流式上屏（Streaming ASR）。
   * 采用 **IPC 管道/WebSocket** 传音频块，延迟是微秒级的；如果走 HTTP，频繁发 HTTP 请求或者建立 TCP 连接，UI 响应会产生肉眼可见的微小顿挫。
2. **系统安全与防火墙弹窗**：
   * 只要 Python 启动 HTTP 服务，Windows 防火墙大概率会弹窗询问：“是否允许 Python 访问局域网网络？”
   * 如果软件**一启动**就默认开启 HTTP 端口，不仅有安全风险，还会让普通用户感到恐慌。而**IPC 管道是纯系统内部通信，完全不需要网络权限，更不会弹防火墙**。
3. **端口冲突问题**：
   * 如果默认走 HTTP 通信，假设默认端口 `9870` 被其他软件占用，整个桌面应用直接死机卡死，用户甚至无法启动软件；而 IPC 管道基于操作系统句柄，永远不会发生“端口冲突”。

---

### 三、 最完美的架构逻辑：按需开启

**你的第二个推测完全正确！这正是现代高质量桌面软件（如 WebUI 工具、Llama.cpp 客户端）的标准设计。**

```text
+-----------------------------------------------------------------------+
|                          桌面软件 (CapsWriter)                          |
|                                                                       |
|  +-------------------+                      +---------------------+   |
|  | Tauri (Rust) 主控  | -- IPC 管道 (高频/低延迟) ->| Python (ASR 引擎)   |   |
|  | - 系统托盘/快捷键  |                      | - 始终常驻内存      |   |
|  | - 模拟打字/上屏    |                      | - 加载 Qwen3-ASR    |   |
|  +-------------------+                      +----------+----------+   |
+--------------------------------------------------------|--------------+
                                                         |
                                        按需开启 (默认关闭)
                                        HTTP/OpenAI 接口 (9870)
                                                         |
                                              +----------v-----------+
                                              |  第三方软件 (外部调用) |
                                              | (Chatbox / Obsidian) |
                                              +----------------------+
```

1. **软件日常运行（默认状态）**：
   * Rust 与 Python 只建立 **IPC 管道**。
   * **端口未开启**：零网络占用、零防火墙弹窗、极速响应、极低延迟。
2. **需要对外提供 API 时（点击启动）**：
   * 用户在设置界面勾选“开启第三方 API 服务”，配置端口 `9870`。
   * Rust 通过 IPC 管道向 Python 发送一条指令：`{"action": "start_http", "port": 9870}`。
   * Python 内部拉起 Uvicorn 线程，对外暴露标准 OpenAI ASR 接口。
   * 第三方软件即可通过 `[http://127.0.0.1:9870/v1/audio/transcriptions](http://127.0.0.1:9870/v1/audio/transcriptions)` 共享使用你本地的 ASR 模型。

这样既保障了客户端本体**极致的响应性能与安全性**，又兼顾了**生态开放与扩展性**。

<ElicitationsGroup message="要继续深入具体的代码实现或打包细节吗？">
  <Elicitation label="查看 Tauri 与 Python 管道 (IPC) 通信代码示例" query="请给我一份 Tauri (Rust) 通过 Stdin/Stdout 管道与 Python Sidecar 进行双向 JSON 通信的具体代码示例。"/>
  <Elicitation label="了解如何将 Qwen3-ASR 与 Python Sidecar 极简打包" query="详细讲解如何用 PyInstaller 裁剪并打包 Qwen3-ASR 和 PyTorch 环境，使其体积尽可能小。"/>
</ElicitationsGroup>

---

# you asked

message time: 2026-08-22 10:28:41

市面上有没有和我这个功能一模一样的软件？

---

# gemini response

市面上**完全将“CapsWriter 模式”（快捷键+极速上屏）和“Qwen3-ASR / 本地大模型 ASR”以及“对外提供 OpenAI 标准 API”完美结合的单文件/绿色桌面软件**，目前还没有出现一个绝对统治地位的统治级产品。

不过，在**部分功能点**或**设计形态**上，有几款非常值得参考和借鉴的开源/商业软件：

---

### 一、 最直接的前辈与竞品

#### 1. **CapsWriter / CapsWriter-Offline**
* **重合点**：功能形态的祖师爷。长按 `Caps Lock` 录音、松开自动识别并模拟键盘粘贴上屏，体验极其流畅。
* **不同点**：CapsWriter 原版使用的是清华大学的 **Sherpa-ONNX (SenseVoice / Paraformer / Zipformer)** 等小模型。它**没有**内置对 Qwen3-ASR 这种新一代大模型 ASR 的支持，也**没有**对外提供标准的 OpenAI Web API 服务。

#### 2. **Whisper-Desktop / Whisper-Node**
* **重合点**：本地运行（基于 C++ / `whisper.cpp`）、支持全局快捷键唤起打字、支持免安装绿色运行。
* **不同点**：完全基于 OpenAI 的 Whisper 模型。Whisper 在中文口语、方言、带吞音的快速输入上，表现远不如专门针对中文优化的 Qwen3-ASR 或 SenseVoice；而且同样缺乏对外提供 HTTP 服务的能力。

#### 3. **SenseVoice-GUI / 各种本地语音打字小工具**
* **重合点**：近一年社区涌现出不少利用 Python / Electron 封装 SenseVoice-Small 的开源小工具，也支持快捷键打字。
* **不同点**：大部分是开发者自用的小脚本或粗糙的 GUI，绝大多数**没有架构设计**（要么是纯 Python 全家桶导致打包巨大，要么是 Electron 占用几百兆内存），且几乎没有做到“支持 Qwen3-ASR + 可控对外提供标准 OpenAI 接口 + 单文件 Portable”。

#### 4. **Sherpa-ONNX 服务化工具**
* **重合点**：部分开发者将 Sherpa-ONNX 封装成了本地 API 服务，方便其他软件调用。
* **不同点**：偏向后端服务/命令行，缺乏优秀的客户端常驻体验（没有完善的悬浮条、快捷键上屏逻辑）。

---

### 二、 你的软件的独特性与市场切入点

如果你按照我们刚才讨论的架构（**Tauri v2 + Qwen3-ASR Python Sidecar + 按需开启 OpenAI 标准 API + 单文件绿色版**）做出来，你的软件将拥有非常强悍的**差异化竞争优势**：

| 维度 | 传统 CapsWriter / 寻常工具 | 你的设计方案 |
| :--- | :--- | :--- |
| **核心识别引擎** | SenseVoice-Small / Paraformer | **Qwen3-ASR**（中文理解力、抗噪、上下文推断能力显著更强） |
| **生态扩展性** | 无，仅限自己打字用 | **内置 OpenAI 标准 API**（随时变身本地语音服务器，给 Chatbox/Obsidian 用） |
| **客户端体验** | 部分软件依赖大环境或打包臃肿 | **Tauri 单文件 Portable.exe**（极速秒开、低内存占用、无安全弹窗） |
| **架构合理性** | 通信乱套，或者强行全套 Python GUI | **IPC 管道高频通信 + 动态按需启动 Web API**，性能与功能平衡极其完美 |

---

### 总结

市面上**没有和你这套功能组合一模一样且做得很完美的成品**。

你现在构思的这个产品，正好精准切中了当前 AI 社区的一个痛点：**既想要一个随时随地极速打字的本地语音输入法，又想把它当成一个本地的语音 AI 微服务**。只要把 Qwen3-ASR 的推理速度优化好（如 ONNX  quantization 或 vLLM/CTranslate2 加速），这个软件在开源社区或效率工具圈子里会非常有吸引力！

<ElicitationsGroup message="想要进一步探讨项目落地细节吗？">
  <Elicitation label="探讨 Qwen3-ASR 的本地推理加速与量化方案" query="针对 Qwen3-ASR 模型，有哪些低显存、高推理速度的 Python 本地量化与加速方案？"/>
  <Elicitation label="规划产品 MVP (最小可行性产品) 功能列表" query="请帮我整理一份这个语音打字/API 软件的 MVP (最小可行性产品) 开发计划与功能列表。"/>
</ElicitationsGroup>

---

# you asked

message time: 2026-08-22 10:34:22

请帮我整理一份这个语音打字/API 软件的 MVP (最小可行性产品) 开发计划与功能列表。

---

# gemini response

这份 MVP（最小可行性产品）开发计划旨在用最短的时间验证核心路径：**“快捷键极速打字”** + **“Qwen3-ASR 本地推理”** + **“可选的 OpenAI 标准 API”**。

---

### 一、 MVP 核心功能列表

#### 1. 核心语音打字 (CapsWriter 模式)
* **全局快捷键**：默认绑定 `CapsLock` 或 `Alt+Space`（支持长按录音、松开识别）。
* **麦克风音频采集**：使用 Python `sounddevice` / `pyaudio` 进行 16kHz 采样率录音。
* **极速文本上屏**：识别完成后，Rust 主进程将文本写入系统剪贴板，并自动模拟 `Ctrl+V` 粘贴到当前活动输入框。
* **托盘与悬浮反馈**：
  * 系统托盘图标（显示运行状态、退出菜单）。
  * 简易悬浮条/状态提示（录音中、识别中、上屏成功）。

#### 2. Qwen3-ASR 本地推理后端 (Python Sidecar)
* **模型加载与推理**：加载 Qwen3-ASR（或量化版本），提供音频字节流到文本的转译函数。
* **VAD (语音活动检测)**：简单集成 Silero-VAD，自动过滤静音段，提升识别效率。
* **IPC 管道通信**：通过 `sys.stdin/stdout` 与 Rust 主进程交换 JSON 控制指令与识别结果。

#### 3. 可选 OpenAI 标准 API 服务
* **标准端点**：实现 `POST /v1/audio/transcriptions` 端点，兼容标准 OpenAI Audio 格式。
* **动态启停控制**：默认关闭；接收到 Rust 指令后再在后台子线程拉起 FastAPI 服务（默认端口 `9870`）。

#### 4. GUI 设置面板 (Tauri Web 界面)
* **快捷键配置**：自定义录音唤起热键。
* **API 服务开关**：启用/禁用第三方 API 服务，并允许修改端口。
* **模型/设备选择**：选择 CPU 或 GPU (CUDA) 进行推理。

---

### 二、 阶段性开发计划 (4 步走)

```
+-----------------------------------------------------------------------------------+
| 阶段一：Python 核心验证    -> 阶段二：Tauri 主控与 IPC   -> 阶段三：API 与联动    -> 阶段四：打包发布 |
| (模型推理 + API 端点)      | (快捷键 + 模拟打字 + 通信)  | (设置界面 + 动态启停)  | (Sidecar 单文件)  |
+-----------------------------------------------------------------------------------+
```

#### 阶段一：Python 核心推理与 API 验证（预计 2~3 天）
* [ ] 搭建 Python 环境，完成 Qwen3-ASR 模型的加载与推理测试。
* [ ] 使用 `FastAPI` + `uvicorn` 编写 `POST /v1/audio/transcriptions` 接口，用 Postman 或 `curl` 测试第三方调用。
* [ ] 编写简单的 `sys.stdin` 监听脚本，确保 Python 端可以通过命令行接收指令并输出 JSON。

#### 阶段二：Tauri 主控与 IPC 管道搭建（预计 3~4 天）
* [ ] 初始化 Tauri (v2) 项目，配置系统托盘与轻量级 GUI 界面。
* [ ] 使用 Rust 系统库实现全局热键监听（长按 `CapsLock` 触发按下/松开事件）。
* [ ] 使用 Tauri 的 Command / Process API 拉起 Python Sidecar，建立 Stdin/Stdout 双向通信。
* [ ] 实现模拟粘贴逻辑：收到 Python 返回的识别文本后，自动写入系统剪贴板并模拟 `Ctrl+V`。

#### 阶段三：控制逻辑与 API 联动（预计 2 天）
* [ ] 在 Tauri 前端添加“开启/关闭第三方 API”开关及端口设置框。
* [ ] 实现动态控制：前端点击“启动 API” -> Rust 组装 JSON 指令发送给 Python -> Python 拉起 Uvicorn 线程。
* [ ] 接入第三方客户端（如 Chatbox、Obsidian 插件）进行联调测试。

#### 阶段四：打包与 Sidecar 裁剪（预计 2~3 天）
* [ ] 使用 `PyInstaller` 或 `Nuitka` 将 Python 后端及其依赖打包为独立的可执行程序 (`qwen-asr-engine.exe`)。
* [ ] 配置 Tauri 的 `tauri.conf.json` 中的 `externalBin` (Sidecar)，将 Python 后端打入同一安装包。
* [ ] 生成最终的 Single Portable `.exe` 免安装绿色文件，进行跨机测试。

---

### 三、 MVP 阶段暂不考虑的特性（留到 V1.5+ 迭代）

为了确保 MVP 能快速上线验证，以下功能建议初期**明确排除**：
1. **复杂的历史记录管理**：MVP 阶段只做“识别即上屏”，不保存历史数据库。
2. **热词 / Lorebook 纠错**：暂不加入自定义替换词库。
3. **TTS（文字转语音）**：专注于 ASR（语音转文字）核心场景。
4. **自动更新机制**：先以绿色免安装 `.exe` 形式分发。

---

### 四、 关键技术栈一览表

| 模块 | 选型 | 作用 |
| :--- | :--- | :--- |
| **主框架 (UI & 系统交互)** | **Tauri (v2)** | 系统托盘、快捷键、剪贴板模拟、界面渲染 |
| **主控语言** | **Rust** | 负责低延迟的系统级操作与 Sidecar 进程生命周期管理 |
| **AI 推理与 API** | **Python 3.10+** | Qwen3-ASR 模型推理、VAD 过滤、FastAPI Web 服务 |
| **Web 框架 (Python)** | **FastAPI + Uvicorn** | 提供 OpenAI 兼容的 `POST /v1/audio/transcriptions` 接口 |
| **打包工具** | **PyInstaller + Tauri Bundler** | 将 Python 与 Rust 组合打包成单文件 Portable `.exe` |

<ElicitationsGroup message="要从哪个模块开始着手编写代码？">
  <Elicitation label="生成 Python 端 FastAPI 与 Stdin 双通道监听代码" query="请帮我编写 Python 端的原型代码：要求同时支持监听 Stdin 指令以及通过 FastAPI 暴露 OpenAI 标准 ASR 接口。"/>
  <Elicitation label="生成 Tauri (Rust) 监听全局热键与模拟上屏代码" query="请提供 Tauri (v2) 中使用 Rust 监听全局快捷键并自动写入剪贴板模拟 Ctrl+V 上屏的代码示例。"/>
</ElicitationsGroup>