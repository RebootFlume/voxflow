//! TTS 子系统共享类型与抽象

use std::path::Path;

use crate::errors::AppError;

/// TTS 统一结果
pub type TtsResult<T> = Result<T, AppError>;

/// TTS 引擎抽象：所有后端（配置驱动的通用 ONNX 引擎、未来的网络后端等）实现此接口
pub trait TtsEngine: Send + Sync {
    /// 引擎/当前模型名称（未加载时为空字符串）
    fn name(&self) -> &str;

    /// 加载模型（`device` 为 "cpu"/"directml"/"cuda"/"metal" 等）
    fn load(&mut self, model_path: &Path, device: &str) -> TtsResult<()>;

    /// 卸载模型（释放显存/内存）
    fn unload(&mut self) -> TtsResult<()>;

    /// 模型是否已加载
    fn is_loaded(&self) -> bool;

    /// 按语言切换（轻量：换 voice embedding，不重载模型）
    fn set_language(&mut self, language: &str) -> TtsResult<()>;

    /// 端到端合成：纯文本 → 24kHz 单声道 i16 PCM（无音素 / 无语速 / 无时长调节）
    fn infer(&mut self, text: &str, voice: &str) -> TtsResult<Vec<i16>>;
}
