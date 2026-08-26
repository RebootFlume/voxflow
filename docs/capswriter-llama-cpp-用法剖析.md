# CapsWriter-Offline 的 llama.cpp 用法剖析（VoxFlow 借鉴版）

> 来源：D:\workspace\CapsWriter-Offline\core\server\engines\force_aligner_gguf\
> 结论先行：它**完全绕开了 llama-cpp 绑定库生态的坑**——不用任何现成绑定包，
> 只手写 ~20 个 C 函数的 ctypes 绑定，直接调官方编译的 llama.dll。

---

## 一、总体架构：三件套模型，llama.cpp 只干一件事

```
Qwen3-ASR 完整推理 = 三个文件分工：

qwen3_asr_encoder_frontend.int4.onnx   ← Mel 频谱提取（ONNX）
qwen3_asr_encoder_backend.int4.onnx    ← 音频编码器（ONNX）→ audio embedding
qwen3_asr_llm.q4_k.gguf                ← LLM 解码器（llama.cpp）

音频 → [ONNX encoder] → embedding → [llama.cpp 注入] → 文本 token 流式输出
```

**关键认知：llama.cpp 在这里只负责 LLM 解码，音频前端全部交给 ONNX。**
而 VoxFlow 已有的 `ort`（ONNX Runtime）正好能跑前两个 ONNX —— 现有依赖不用扔。

## 二、只绑定 20 个 C 函数（这就是它避坑的核心）

CapsWriter 没用任何 llama binding 库，`llama.py` 手写 ctypes 绑定，完整函数清单：

```text
后端初始化（3个）：
  ggml_backend_load_all()        ← 动态加载 GPU 后端（CUDA/Vulkan 等 dll 自动发现）
  llama_backend_init()
  llama_log_set(cb, null)        ← 重定向 C 日志到自己的 logger

模型加载（4个）：
  llama_model_load_from_file(path, params)   ← params.n_gpu_layers = -1 全部卸载到 GPU
  llama_model_free(ptr)
  llama_model_get_vocab(ptr)
  llama_model_n_embd(ptr)                    ← embedding 维度（构造注入 buffer 用）

上下文（3个）：
  llama_context_default_params()
  llama_init_from_model(model, params)       ← n_ctx / n_batch=4096 / flash_attn / n_threads
  llama_free(ptr)

批处理与解码（5个）：
  llama_batch_init(n, embd_dim, n_seq)       ← embd_dim = n_embd，启用 embedding 注入模式
  llama_batch_get_one(&token, 1)             ← 单 token 生成用的零分配 batch
  llama_batch_free()
  llama_decode(ctx, batch)                   ← 预填充和生成都用它
  llama_get_logits_ith(ctx, i)               ← 取 logits 给采样器

词表操作（4个）：
  llama_tokenize(vocab, bytes, ...)          ← 特殊 token 用 parse_special=true 解析
  llama_token_to_piece(vocab, id, ...)
  llama_vocab_n_tokens(vocab)
  llama_vocab_eos(vocab)

KV cache（2个）：每片音频解码前必须清空
  llama_get_memory(ctx)
  llama_memory_clear(mem, true)

采样链（约10个）：
  chain_init / chain_add / sample / accept / free
  + greedy / dist(seed) / temp / top_k / top_p / min_p / penalties / logit_bias
```

**对比坑点**：llama-cpp-2 这类绑定 crate 把这些 API 包了一层自己的抽象，
版本滞后、multimodal 注入接口缺失、构建系统耦合 CMake。
CapsWriter 的做法证明：核心推理面就这么大，自己绑反而最稳。

## 三、Windows DLL 加载的坑（它的解法）

```python
# llama.py 的 init()：
# 1. 先 chdir 到 bin 目录 + 加入 PATH + os.add_dll_directory()
# 2. 按依赖顺序加载：ggml-base.dll → ggml.dll → llama.dll
# 3. 立刻 ggml_backend_load_all() 让 CUDA/Vulkan 后端自动挂载
# 4. llama_log_set() 重定向日志，避免 C 层 printf 打爆 stdout
```

Rust 对应方案（FFI 时同样适用）：
- 用 `libloading::Library::new()` 按 `ggml-base → ggml → llama` 顺序加载，
  加载前把 bin 目录插入 DLL 搜索路径（`SetDllDirectoryW` 或 `add_dll_directory`）
- 或最简单：把官方 release 的全套 dll 和 exe 放同一目录随应用分发

## 四、多模态 Embedding 注入（核心技术，llama-cpp-2 缺失的部分）

### 4.1 Prompt 结构（Qwen3-ASR 专用模板）

```text
<|im_start|>system\n{context或默认}<|im_end|>
<|im_start|>user\n<|audio_start|>
【audio embedding × N 帧】            ← ONNX 编码器的输出直接塞进 embd
<|audio_end|><|im_end|>
<|im_start|>assistant\n[language zh]<asr_text>{前文记忆}
```

特殊 token ID 通过 `tokenize(parse_special=true)` 从模型词表取，
不硬编码。

### 4.2 注入实现（set_embd）

```python
batch = llama_batch_init(max_len*4, n_embd, 1)   # embd_dim ≠ 0 → 启用 embd 模式
ctypes.memmove(batch.embd, data.ctypes.data, data.nbytes)  # f32 [n_tokens, n_embd]
# Qwen3 多平面位置编码（M-RoPE）：pos 是 4 组拼接
pos = concat([0..n, 0..n, 0..n, zeros(n)])
memmove(batch.pos, ...)
batch.logits[i] = (i == last)     # 只有最后一个位置要 logits
llama_decode(ctx, batch)          # 一次性预填充
```

### 4.3 词向量表的取巧：不经过 llama.cpp

构造 prompt 时文本部分也需要 embedding（和音频拼一起）。
CapsWriter 直接用 `np.memmap` 二进制解析 GGUF 文件头，
定位 `token_embd.weight` 张量偏移，按需反量化取行（<50ms，不用加载整个模型）。

## 五、生成循环与流式输出（Push-to-Talk 关键细节）

```python
# 预填充：清 KV cache → decode 整个 embedding batch（一次）
ctx.clear_kv_cache(); ctx.decode(big_batch)

# 逐 token 生成（最多512个）：
tok = sampler.sample(ctx.ptr)             # 采样链内部自动 accept
while tok not in [eos, <|im_end|>] and n < 512:
    ctx.decode(get_one_batch(tok))        # 单token零分配batch
    display_queue.push(tok)               # 滚动窗口：最后5个token暂不提交
    if len(queue) > rollback_num:         # 过了回滚窗口才对外吐字
        piece = incremental_utf8.decode(token_to_bytes(tok))  # 处理跨token的UTF8
        yield piece                       # ← 流式输出给前端
    # 熔断：最近15个token去重后≤3种 → 判定死循环 → 中断
    if len(stable) > 15 and len(set(stable[-15:])) <= 3: break
    tok = sampler.sample(...)
# 熔断后 temperature += 0.3 重试，最多4次
```

每次解码换随机 seed 新建采样器；长音频切 40 秒一片，
保留最近 2 片的 (embedding, text) 作为上下文记忆拼进 prompt。

## 六、进程隔离（与你的崩溃隔离要求一致）

```
主进程（WebSocket 服务 + 托盘）
   │ multiprocessing.Queue(in/out)
   ▼
识别 worker 子进程：加载模型（queue_out.put(True) 报告就绪）
   ├─ 模型损坏/显存不足崩溃 → 主进程检测 exitcode ≠ 0 → 提示用户，主程序不死
   └─ 推理任务经 queue_in 进，结果经 queue_out 出
```

## 七、映射到 VoxFlow：你要写的东西清单

```text
 crates/llama-sys-lite/（自建，替代 llama-cpp-2）      工作量：中
 ├─ libloading 按序加载 ggml-base/ggml/llama dll
 ├─ extern 声明上表 ~25 个 C 函数（结构体 5 个：model_params/context_params/batch/sampler_params/logit_bias）
 ├─ 安全封装：Model/Context/Batch/Sampler（Drop 释放，仿 CapsWriter 的 OOP 层）
 └─ set_embd()：f32 slice → batch.embd memmove + 自定义 pos 数组

 ASR 音频编码器：复用现有 ort 跑 frontend/backend onnx    工作量：低（ort 已通）

 ASR 服务进程：独立 exe 或 Tauri spawn 的子进程           工作量：中
 └─ IPC 可选：命名管道 / TCP / stdio 行协议（推荐 stdio JSON-lines，最简单）

 sherpa-onnx 路线：官方 release 的可执行文件/动态库        工作量：低-中
 ├─ 方式1：subprocess 调官方 CLI（最快验证）
 └─ 方式2：libloading 绑定 sherpa-onnx C API（流式 ASR + VITS TTS）
```

## 八、性能参考（CapsWriter 实测打印的指标）

- RTF = 总耗时/音频时长（目标 < 0.3 即有"跟手"感）
- 分别统计：encode（ONNX）/ prefill（tokens/s）/ generate（tokens/s）
- 建议 VoxFlow 的 ASR 服务从第一天就输出这三个指标，用于量化"及时性"

## 九、风险与注意

1. **GGUF 版本兼容**：llama.cpp 迭代快，锁定一个官方 release 版本号，别追最新
2. **M-RoPE pos 数组是 Qwen3 专属**：换其他 ASR GGUF（如 Fun-ASR-Nano）结构不同，
   CapsWriter 里 fun_asr_nano 用的是 encoder_adaptor+ctc+llm_decode 另一套管线
3. **int4 ONNX encoder 需要 DirectML/CUDA provider 才快**，CPU 也能跑但慢；
   注意 dml_pad_to=40 的定长填充逻辑
4. **KV cache 必须每片清空**，否则长会话显存涨穿
