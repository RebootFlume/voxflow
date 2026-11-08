# 推理框架升级手册

推理层现在是三个进程内 FFI 框架，各自把 C ABI 手工复述成 koffi 绑定：

| 框架 | 运行时包 key | 绑定文件 | 风险 | 原因 |
| --- | --- | --- | --- | --- |
| llama.cpp | `gguf` | `src/main/inference/llama-ffi/bindings.ts` | **高** | 结构体按值传递（`*_default_params()` 返回结构体），字段错位必然发生，且不会崩溃，只会算错 |
| sherpa-onnx | `onnx` | `src/main/inference/sherpa-ffi/bindings.ts` | 中 | 配置按指针传；新字段大多追加在尾部，但仍可能出现「插在中间」和「行为变化」 |
| audio.cpp | `audiocpp` | `src/main/inference/audiocpp-ffi/bindings.ts` | 低 | 全部 opaque 句柄；带 `audiocpp_abi_version()`，我们校验 `REQUIRED_ABI = 0x0200` |

「升级会出错」的本质不是文件换了，而是 **C 头文件的结构体布局变了，而我们的 koffi 声明没跟着变**。绑定层不会报错，只会静默读错字段。

## 一、先看清要做什么

```bash
npm run check:updates
```

输出三行：当前 pin、官方最新、是否落后。落后时它会提示下一步命令。

## 二、查 ABI 差异（核心步骤，必做）

```bash
npm run check:abi                       # 校验当前 pin 的三个框架
npm run check:abi gguf b12345           # 升级前预演某个新版本
npm run check:abi onnx v2.1.0 --offline # 只用本地缓存（无网时）
```

脚本做的事：

1. 从 `src/main/inference/runtime-download.ts` 读每个框架当前 pin 的 `version`
2. 从 GitHub raw 拉对应 tag 的头文件，缓存到 `.cache/abi/<framework>-<version>/`（已缓存则不再下载）
3. 解析头文件里的 `struct` / `typedef struct`，与绑定文件里的 `koffi.struct(...)` **逐字段名比对**
4. 输出「必须补 / 必须删 / 顺序不对」，并给出建议插入位置（插在哪个邻居之后）
5. 有差异退出码 1

它**不比对字段类型**（C 类型与 koffi 声明不是一一对应，强比对全是误报）。类型需要人看头文件——脚本的价值是把范围从「46 个函数 + 一堆结构体」缩到「三个具体字段」。

它**不自动改代码**，原因：

- 新字段可能插在结构体中间（盲目追加会错位整段布局）；
- 字段语义可能变（例如 sherpa v2.0.0 把 `data_dir` 从「有用」改成「deprecated 且 ignored」，任何 diff 都发现不了）；
- 函数签名/默认值变化需要人判断。

## 三、改绑定（按 diff 输出逐条处理）

规则：**C 结构体的字段顺序就是内存顺序，绑定必须逐字段照抄，一个不能少、一个不能多、顺序不能变。**

- 追加在尾部：直接加，并在注释里写清新版本号（例：`/** b12211 新增 */`）。
- 插在中间：找到 diff 给出的前后邻居，插进去。
- 不只是结构体：**导出函数表**也要扫一眼（`lib.func(...)` 列表），确认函数名、参数个数没变。`check:abi` 目前不覆盖函数签名，需要人对着头文件看，或用 `--dump` 方式 grep 头文件。

## 四、改下载条目

在 `src/main/inference/runtime-download.ts` 里改对应包对象的字段：

| 字段 | 说明 |
| --- | --- |
| `version` | 官方 tag（llama 是 `b####`，其余是 `vX.Y.Z`） |
| `url` / `auxUrl` | 资产地址；**先用浏览器/curl 确认存在**，并核对 `Content-Length` |
| `innerDir` | 包内顶层目录名。`placeExtracted()` 会自动剥离「只有一个顶层目录」的情况，所以平铺包写 `''`。**每次升级都要解压看一眼**：zip/tar 结构换过不止一次（llama b12211 就从带 wrapper 目录变成平铺） |
| `marker` | 安装完整性判据（某个 exe/dll 的相对路径） |
| `targetDir` | 落到 `libs/<targetDir>` |
| `portBase` / `smokeProbe` | 试启动参数；纯库类（如 audio.cpp）用 `{ type: 'skip' }` |

## 五、版本戳

安装流程会在 `libs/<targetDir>/.installed-version` 写入 `version`。`isRuntimeInstalled()` 会校验它：

- 已有旧运行时但版本戳不匹配 → 判定为「需要重新下载」，避免新旧 DLL 混用；
- 手工把包拷进 `libs/` 时，**必须自己写这个文件**（内容就是版本号 + 换行），否则会被要求重下。

## 六、验证（不能只靠 typecheck）

```bash
npm run typecheck && npm run build
npm run test:tts            # 写参数逻辑的纯函数测试
```

真机验证（应用内通过 CDP 或 UI 执行）：

1. `check_runtime` → 三个包 `ready`，版本号是新的；
2. 模型清单能列出来；
3. **至少各跑一条 ASR 和 TTS**：加载模型 → 转写/合成 → 输出非静音；
4. 看日志里有没有框架自己打的版本/后端行（例：llama 的 `ggml_cuda_init: found 1 CUDA devices`、`load_backend: loaded CUDA backend`）。

只解析符号是不够的：今天 llama b12211 的 46 个函数全部解析成功，但三个结构体都变了。符号能解析 ≠ ABI 没变。

## 七、三个框架各自的已知坑

### llama.cpp
- 二进制版本是 nightly tag `b####`；`releases/latest` 可能是 semver `v0.9.0`，其资产只有 `nightly-tag.txt`。`check:updates` 已按 `^b\d+$` 取最新构建。
- 结构体按值传递：`llama_model_default_params()` / `llama_context_default_params()` / `mtmd_context_params_default()` 返回结构体，sizeof 不一致会直接踩内存。
- 必绑 DLL：`ggml-base.dll`、`ggml.dll`、`llama.dll`、`mtmd.dll`（CUDA 版还带 `ggml-cuda.dll`）。

### sherpa-onnx
- 配置结构体极大，新字段一般追加尾部，但**也可能插在中间**，以 `check:abi` 为准。
- 注意**行为破坏**：v2.0.0 起 TTS 的 `data_dir`（espeak-ng）被标 deprecated 且忽略，Kokoro 的 `lang` 同样被忽略，语言由 lexicon 决定。这类变化 `check:abi` 看不出来，必须读 release notes。
- 包内 `lib/sherpa-onnx-c-api.dll` 需要先加载 `lib/onnxruntime.dll`。

### audio.cpp
- 先校验 `audiocpp_abi_version()` 与 `REQUIRED_ABI`，不一致应直接报错而不是继续跑。
- 部分模型族（kokoro / kitten / piper / zipvoice / sanotts / inflect）需要外部 eSpeak-ng（GPL-3.0），本项目**不引入**；选模型时优先自带文本前端的族（如 MOSS-TTS-Nano）。
- 音频返回的是裸指针，必须 `koffi.decode(ptr, 'float', frames * channels)`。

## 八、提交前检查清单

- [ ] `npm run check:abi` 全绿
- [ ] `npm run typecheck` / `npm run build` 通过
- [ ] `libs/<targetDir>/.installed-version` 与本 pin 一致
- [ ] 真机跑过 ASR + TTS 各一条
- [ ] 旧运行时备份已删（`libs/xxx.b####` 之类）
- [ ] `runtime-download.ts` 头注释里的版本号同步更新

## 九、回滚

```bash
git revert <commit>                       # 代码回滚
rm -rf libs/<targetDir>                   # 让安装器重新下载旧版本
```

`check_runtime` 会显示版本不符，重新安装即可回到 pin 的版本。
