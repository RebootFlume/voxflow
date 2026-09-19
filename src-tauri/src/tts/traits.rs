//! TTS 子系统共享类型与抽象

use std::path::Path;

use crate::errors::AppError;

/// TTS 统一结果
pub type TtsResult<T> = Result<T, AppError>;

/// 合成音频：采样率由引擎按模型实际输出声明，边缘层（命令/API）据此写文件，
/// 不再硬编码 24000（修复旧实现采样率谎报导致的变速播放）。
#[derive(Debug, Clone)]
pub struct SynthAudio {
    pub samples: Vec<i16>,
    pub sample_rate: u32,
}

/// TTS 引擎抽象（框架契约，见方案文档 3.2 / 4.2）
///
/// 签名契约（P1 冻结）：
/// - 全部方法 `&self`：可变状态收进引擎内部锁，registry 才能安全持有 `Arc<dyn TtsEngine>`。
/// - `synthesize` 返回 `SynthAudio`（带真实采样率）。
/// - 新增方法一律提供默认实现，不破坏已注册引擎。
pub trait TtsEngine: Send + Sync {
    /// 引擎/当前模型名称（未加载时为空字符串）
    fn name(&self) -> &str;

    /// 加载模型（`model_path` 为主模型文件路径；`device` 为 "cpu"/"cuda"/"directml"/"metal"）
    fn load(&self, model_path: &Path, device: &str) -> TtsResult<()>;

    /// 卸载模型（释放显存/内存）
    fn unload(&self) -> TtsResult<()>;

    /// 模型是否已加载
    fn is_loaded(&self) -> bool;

    /// 按语言切换（轻量，不重载模型；引擎按自身描述符的语言列表校验）
    fn set_language(&self, language: &str) -> TtsResult<()>;

    /// 端到端合成：纯文本 → PCM + 真实采样率（无音素 / 无语速 / 无时长调节）
    fn synthesize(&self, text: &str, voice: &str) -> TtsResult<SynthAudio>;

    /// 设置语音克隆参数（仅克隆模型支持；默认拒绝，避免命令层向下转型）
    fn set_clone_voice(&self, _audio: &Path, _text: &str) -> TtsResult<()> {
        Err(AppError::InvalidInput("当前 TTS 模型不支持语音克隆".into()))
    }

    /// 清除语音克隆参数（默认 no-op）
    fn clear_clone_voice(&self) {}

    /// 估算当前模型显存占用（MB），用于显存监控；无权限时回退 None
    fn vram_estimate_mb(&self) -> Option<u64> {
        None
    }
}
