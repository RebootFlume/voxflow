# 项目进度

## Rust 引擎迁移 — Python 已禁用 ✅

### 完成状态
- [x] Python sidecar 启动代码已注释（保留备份供查阅）
- [x] `useRustEngine` 默认 true
- [x] `send_to_sidecar_safe` 安全版本（Python 不存在时返回模拟响应）
- [x] 热键监听已禁用（依赖 sidecar）
- [x] cargo check --lib 零警告零错误 ✅
- [x] npm build ✅
- [x] Python 代码保留为备份，不参与工作

### 当前架构
```
前端
  ├─ ASR 转写 → rustTranscribe(filePath) → Rust GGUF 推理
  ├─ TTS 合成 → rustSynthesize(text) → Rust ONNX 推理
  ├─ sendToSidecar → 安全版本（Python 不存在时返回模拟响应）
  └─ onSidecarEvent → 空（无 Python 事件）
```

### Python 备份位置
```
python-backend/          ← 完整备份，供查阅
├── app.py               ← 主入口
├── voxflow/
│   ├── asr_engine.py    ← PyTorch ASR 引擎
│   ├── tts_engine.py    ← Kokoro TTS 引擎
│   ├── recorder.py      ← sounddevice 录音
│   └── ...              ← 其他模块
└── tests/               ← 测试用例
```

### 待完成
- [ ] TTS：修复 ONNX 推理输出（确认输出 tensor 名称）
- [ ] ASR：完成 llama-cpp-2 mtmd 真实推理
- [ ] 验证：同一输入，Rust 输出与 Python 备份一致
