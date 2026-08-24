#!/bin/bash
# 测试 TTS 加载的简单脚本

echo "=== 测试 TTS 模型加载 ==="
echo ""

# 检查模型文件是否存在
MODEL_DIR="D:/app/ai/workspace/voxflow/models/Kokoro-82M"
ONNX_FILE="$MODEL_DIR/onnx/model_q8f16.onnx"
TOKENIZER="$MODEL_DIR/tokenizer.json"
VOICE="$MODEL_DIR/voices/af.bin"

echo "检查模型文件..."
if [ -f "$ONNX_FILE" ]; then
    echo "✓ ONNX 模型: $ONNX_FILE ($(ls -la "$ONNX_FILE" | awk '{print $5}') bytes)"
else
    echo "✗ ONNX 模型不存在: $ONNX_FILE"
    exit 1
fi

if [ -f "$TOKENIZER" ]; then
    echo "✓ Tokenizer: $TOKENIZER"
else
    echo "✗ Tokenizer 不存在: $TOKENIZER"
    exit 1
fi

if [ -f "$VOICE" ]; then
    echo "✓ Voice: $VOICE"
else
    echo "✗ Voice 不存在: $VOICE"
    exit 1
fi

echo ""
echo "=== 文件检查通过 ==="
echo ""
echo "启动 VoxFlow 应用..."
echo "请在应用中："
echo "1. 进入 TTS → Model & Device"
echo "2. 选择 Kokoro-82M 模型"
echo "3. 观察加载状态变化"
echo "4. 进入 Text to Speech"
echo "5. 输入文本并点击合成"
