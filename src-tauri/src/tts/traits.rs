//! TTS 子系统共享类型与抽象

use std::path::Path;

use crate::errors::AppError;

/// TTS 统一结果
pub type TtsResult<T> = Result<T, AppError>;

/// 单次合成请求的管道上下文
#[derive(Debug, Clone)]
pub struct PipelineContext<'a> {
    /// 合成文本
    pub text: &'a str,
    /// 目标语言（"zh"/"en"/"ja"…）
    pub lang: &'a str,
    /// 用户选定的音色名（可选；缺省用语言默认音色）
    pub voice: Option<&'a str>,
    /// 语速倍率（0.5–2.0）
    pub rate: f64,
}

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

    /// 按语言切换（轻量：换 voice embedding / G2P voice，不重载模型）
    fn set_language(&mut self, language: &str) -> TtsResult<()>;

    /// 合成文本 → 24kHz 单声道 i16 PCM
    fn infer(&mut self, text: &str, voice: &str, rate: f64) -> TtsResult<Vec<i16>>;
}
