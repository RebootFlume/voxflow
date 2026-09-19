//! sherpa-onnx E2E TTS 引擎（子进程模式，描述符驱动）
//!
//! 架构：调用 `libs/sherpa-onnx/sherpa-onnx-offline-tts.exe` 子进程合成音频，
//! 与 ASR 的 llama-server 子进程一致 —— 推理框架与桌面应用进程隔离。
//!
//! P2 重构要点（方案文档 4.2）：
//! - 模型差异全部收敛在 `ModelSpec` 描述符（spec.rs），本文件**无模型分支**。
//! - argv 由 `ArgSpec` 解释器（argv.rs）拼装；黄金 diff 测试保证与旧 cli_args 一致。
//! - 全部方法 `&self`（内部锁），供 `TtsRegistry` 以 `Arc<dyn TtsEngine>` 持有。
//! - device 参数真实接线：cpu → --provider=cpu，其余 → --provider=cuda（修复旧 bug）。
//! - `synthesize` 返回 `SynthAudio`（真实采样率），不再硬编码 24k、不再重采样。

use std::path::{Path, PathBuf};
use std::process::Command;

use parking_lot::Mutex;

use crate::errors::AppError;
use crate::tts::engine::argv::{build_argv, ArgEnv};
use crate::tts::spec::{BackendSpec, ModelSpec, VoiceMode};
use crate::tts::traits::{SynthAudio, TtsEngine, TtsResult};

/// 引擎可变状态（&self 接口下的内部锁）
struct SherpaInner {
    /// 当前模型描述符（None = 未加载）
    spec: Option<&'static ModelSpec>,
    /// models 根目录
    model_root: PathBuf,
    /// 说话人 ID（Kokoro / Supertonic 等多说话人模型）
    sid: i32,
    /// 推理提供者（由 device 映射：cpu / cuda）
    provider: String,
    /// 推理线程数（CPU 模式生效）
    num_threads: i32,
    /// 当前语言（Supertonic 等需 --lang 的模型使用）
    language: String,
    /// 语音克隆：参考音频路径（ZipVoice 使用）
    reference_audio: Option<PathBuf>,
    /// 语音克隆：参考音频对应的文本（ZipVoice 需要）
    reference_text: Option<String>,
}

/// sherpa-onnx E2E TTS 引擎
pub struct SherpaTtsEngine {
    inner: Mutex<SherpaInner>,
}

impl Default for SherpaTtsEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl SherpaTtsEngine {
    pub fn new() -> Self {
        let model_root = crate::model_manager::get_model_root();
        Self {
            inner: Mutex::new(SherpaInner {
                spec: None,
                model_root,
                sid: 0,
                provider: "cuda".to_string(),
                num_threads: 4,
                language: "zh".to_string(),
                reference_audio: None,
                reference_text: None,
            }),
        }
    }

    /// TTS 工具 exe 的规范路径（<sherpa_runtime_dir>/bin/…）。
    /// 每次调用解析，不在 new() 缓存 —— 保证"先启动应用、后下载框架"也能立刻可用。
    fn tts_exe() -> PathBuf {
        crate::inference::runtime_paths::sherpa_exe("sherpa-onnx-offline-tts.exe")
    }

    /// 从模型文件路径解析描述符：目录名优先（models_root/<dir>/model.onnx），文件名兜底。
    fn resolve_spec(model_path: &Path) -> Option<&'static ModelSpec> {
        if let Some(dir) = model_path.parent() {
            if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
                if let Some(spec) = ModelSpec::find(name) {
                    return Some(spec);
                }
            }
        }
        if let Some(name) = model_path.file_name().and_then(|s| s.to_str()) {
            if let Some(spec) = ModelSpec::find(name) {
                return Some(spec);
            }
        }
        None
    }

    /// 检查推理框架与模型文件是否齐全（含 ModelsRootFile 参数，如 ZipVoice vocoder）
    fn check_ready(&self, inner: &SherpaInner, spec: &'static ModelSpec) -> Result<(), AppError> {
        let exe = Self::tts_exe();
        if !exe.exists() {
            return Err(AppError::LoadFailed(format!(
                "sherpa-onnx TTS 推理框架不存在: {}",
                exe.display()
            )));
        }
        let dir = inner.model_root.join(spec.id);
        if !dir.exists() {
            return Err(AppError::LoadFailed(format!(
                "模型 {} 目录不存在: {}",
                spec.name,
                dir.display()
            )));
        }
        let BackendSpec::SherpaTts(tts_spec) = &spec.backend else {
            return Err(AppError::LoadFailed(format!("{} 不是 sherpa TTS 模型", spec.name)));
        };
        for f in tts_spec.required_files {
            let p = dir.join(f);
            if !p.exists() {
                return Err(AppError::LoadFailed(format!(
                    "模型 {} 缺少文件: {}",
                    spec.name,
                    p.display()
                )));
            }
        }
        // ModelsRootFile 参数（如 vocos_24khz.onnx）也纳入加载期校验
        for arg in tts_spec.cli {
            if let crate::tts::spec::ArgSpec::ModelsRootFile(_, rel) = arg {
                let p = inner.model_root.join(rel);
                if !p.exists() {
                    return Err(AppError::LoadFailed(format!(
                        "模型 {} 缺少 models 根文件: {}",
                        spec.name,
                        p.display()
                    )));
                }
            }
        }
        Ok(())
    }

    /// 合成并返回 WAV 字节 + 采样率（临时文件方式，避免 stdout 二进制被污染）
    fn synthesize_to_file(&self, inner: &SherpaInner, text: &str) -> Result<(Vec<u8>, u32), AppError> {
        let spec = inner.spec.ok_or(AppError::NotInitialized)?;
        let BackendSpec::SherpaTts(tts_spec) = &spec.backend else {
            return Err(AppError::LoadFailed("非 sherpa TTS 模型".into()));
        };
        let out_dir = std::env::temp_dir();
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let out_path = out_dir.join(format!("voxflow_tts_{ts}.wav"));

        let env = ArgEnv {
            model_dir: &inner.model_root.join(spec.id),
            models_root: &inner.model_root,
            provider: &inner.provider,
            num_threads: inner.num_threads,
            sid: inner.sid,
            language: &inner.language,
            output: &out_path,
            reference_audio: inner.reference_audio.as_deref(),
            reference_text: inner.reference_text.as_deref(),
        };
        let mut args = build_argv(tts_spec, &env);
        args.push(format!("--output-filename={}", out_path.display()));

        let mut cmd = Command::new(Self::tts_exe());
        cmd.args(&args);
        cmd.arg(text);

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let output = cmd
            .output()
            .map_err(|e| AppError::InferenceFailed(format!("sherpa-tts 启动失败: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let _ = std::fs::remove_file(&out_path);
            return Err(AppError::InferenceFailed(format!(
                "sherpa-tts 失败 (exit={}): {}",
                output.status.code().unwrap_or(-1),
                stderr.lines().last().unwrap_or("")
            )));
        }

        let wav = std::fs::read(&out_path)
            .map_err(|e| AppError::InferenceFailed(format!("读取合成结果失败: {e}")))?;
        let _ = std::fs::remove_file(&out_path);

        // 解析采样率（WAV header offset 24）
        let sample_rate = if wav.len() >= 28 {
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]])
        } else {
            24000
        };

        Ok((wav, sample_rate))
    }

}

impl TtsEngine for SherpaTtsEngine {
    fn name(&self) -> &str {
        self.inner.lock().spec.map(|s| s.id).unwrap_or("")
    }

    fn load(&self, model_path: &Path, device: &str) -> TtsResult<()> {
        let spec = Self::resolve_spec(model_path).ok_or_else(|| {
            AppError::LoadFailed(format!("无法识别 E2E TTS 模型: {}", model_path.display()))
        })?;

        let mut inner = self.inner.lock();
        // 候选状态先写入再校验，校验失败必须回滚：否则 is_loaded()（= spec.is_some()）会**谎报已加载**
        // ——明明模型不可用，界面却显示就绪，且用户原来加载的模型被顶掉。
        let prev_spec = inner.spec;
        let prev_provider = inner.provider.clone();
        inner.spec = Some(spec);
        // device → provider（修复旧实现 device 失效：CPU 选项真实生效）
        inner.provider = match device.trim().to_ascii_lowercase().as_str() {
            "cpu" => "cpu".to_string(),
            _ => "cuda".to_string(),
        };

        if let Err(e) = self.check_ready(&inner, spec) {
            inner.spec = prev_spec;
            inner.provider = prev_provider;
            return Err(e);
        }

        // 语言对齐：当前语言不在描述符支持列表 → 切到 "en"（有则用）否则首个支持语言
        if !spec.languages.contains(&inner.language.as_str()) {
            let fallback = if spec.languages.contains(&"en") { "en" } else { spec.languages[0] };
            inner.language = fallback.to_string();
        }
        Ok(())
    }

    fn unload(&self) -> TtsResult<()> {
        let mut inner = self.inner.lock();
        inner.spec = None;
        inner.reference_audio = None;
        inner.reference_text = None;
        Ok(())
    }

    fn is_loaded(&self) -> bool {
        self.inner.lock().spec.is_some()
    }

    fn set_language(&self, language: &str) -> TtsResult<()> {
        let mut inner = self.inner.lock();
        if let Some(spec) = inner.spec {
            if !spec.languages.contains(&language) {
                return Err(AppError::InvalidInput(format!(
                    "模型 {} 不支持语言 '{language}'（支持: {}）",
                    spec.name,
                    spec.languages.join(", ")
                )));
            }
        }
        inner.language = language.to_string();
        Ok(())
    }

    /// 设置语音克隆参数（ZipVoice 等克隆模型）
    ///
    /// 之前这两个方法只以「固有方法」存在、**没有进 trait impl** ⇒ 命令层经
    /// `Arc<dyn TtsEngine>` 调用时命中 trait 默认实现：任何模型都被拒（"当前 TTS 模型
    /// 不支持语音克隆"），而"清除克隆"走默认 no-op 静默失效。必须实现在 trait 里。
    fn set_clone_voice(&self, audio: &Path, text: &str) -> TtsResult<()> {
        let mut inner = self.inner.lock();
        let spec = inner
            .spec
            .ok_or_else(|| AppError::InvalidInput("TTS 模型未加载，无法设置克隆音色".into()))?;

        // 能力来自描述符（不做模型名分支）：只有 clone / preset_and_clone 接受克隆参数
        let requires_text = match spec.voice_mode {
            VoiceMode::Clone(c) | VoiceMode::PresetAndClone(_, c) => c.requires_text,
            _ => {
                return Err(AppError::InvalidInput(format!(
                    "当前 TTS 模型（{}）不支持语音克隆",
                    spec.name
                )))
            }
        };

        let text = text.trim();
        if requires_text && text.is_empty() {
            return Err(AppError::InvalidInput(format!(
                "模型 {} 需要参考文本（参考音频里说的内容）",
                spec.name
            )));
        }
        if !audio.is_file() {
            return Err(AppError::LoadFailed(format!(
                "参考音频不存在: {}",
                audio.display()
            )));
        }

        inner.reference_audio = Some(audio.to_path_buf());
        // 空文本存 None：argv 解释器按 Some/None 决定是否拼 `--reference-text`，
        // 存 Some("") 会拼出空值参数（需要对不要求文本的克隆模型安全）
        inner.reference_text = (!text.is_empty()).then(|| text.to_string());
        Ok(())
    }

    /// 清除语音克隆参数（回到预设音色）
    fn clear_clone_voice(&self) {
        let mut inner = self.inner.lock();
        inner.reference_audio = None;
        inner.reference_text = None;
    }

    fn synthesize(&self, text: &str, voice: &str) -> TtsResult<SynthAudio> {
        if !self.is_loaded() {
            return Err(AppError::NotInitialized);
        }
        if text.is_empty() {
            return Ok(SynthAudio { samples: Vec::new(), sample_rate: 0 });
        }
        // voice 参数作为 sid（如 "45"）；非法值保持当前 sid（与旧实现一致）
        let mut inner = self.inner.lock();
        if let Ok(v) = voice.parse::<i32>() {
            inner.sid = v;
        }

        let (wav, sample_rate) = self.synthesize_to_file(&inner, text)?;

        // WAV → i16 PCM：定位 data chunk
        let mut off = 12;
        let mut data_start = 0usize;
        let mut data_len = 0usize;
        while off + 8 <= wav.len() {
            let id = &wav[off..off + 4];
            let sz = u32::from_le_bytes([wav[off + 4], wav[off + 5], wav[off + 6], wav[off + 7]])
                as usize;
            if id == b"data" {
                data_start = off + 8;
                data_len = sz;
                break;
            }
            off += 8 + sz;
        }
        if data_len == 0 || data_start + data_len > wav.len() {
            return Err(AppError::InferenceFailed("合成 WAV 无音频数据".into()));
        }

        let mut samples = Vec::with_capacity(data_len / 2);
        let mut i = data_start;
        while i + 1 < data_start + data_len {
            let v = i16::from_le_bytes([wav[i], wav[i + 1]]);
            samples.push(v);
            i += 2;
        }

        // 返回真实采样率（不再强制 24k / 重采样；WAV 头与 PCM 一致即正确播放）
        Ok(SynthAudio { samples, sample_rate })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：克隆方法必须**实现在 trait impl 里**，否则命令层经 `Arc<dyn TtsEngine>` 调用会
    /// 命中 trait 默认实现 —— 无论加载什么模型都返回"当前 TTS 模型不支持语音克隆"（用户实测踩到）。
    /// 本测试经 `&dyn TtsEngine` 调用：未加载模型时应报"未加载"，绝不能是"不支持克隆"那句。
    #[test]
    fn clone_methods_are_reachable_through_dyn() {
        let engine = SherpaTtsEngine::new();
        let dyn_engine: &dyn TtsEngine = &engine;
        let err = dyn_engine
            .set_clone_voice(Path::new("no-such-file.wav"), "文本")
            .expect_err("未加载模型必须报错");
        let msg = err.to_string();
        assert!(
            !msg.contains("不支持语音克隆"),
            "命中了 trait 默认实现（= 没在 trait impl 里覆写）: {msg}"
        );
        // clear 也必须可达（默认实现是 no-op，静默失效）
        dyn_engine.clear_clone_voice();
    }

    #[test]
    fn test_resolve_spec_by_dir() {
        let p = Path::new("models/kokoro-multi-lang-v1_0/model.onnx");
        let spec = SherpaTtsEngine::resolve_spec(p).expect("应解析到 spec");
        assert_eq!(spec.id, "kokoro-multi-lang-v1_0");
    }

    #[test]
    fn test_resolve_spec_by_file() {
        let p = Path::new("models/sherpa-onnx-zipvoice-distill/encoder.onnx");
        let spec = SherpaTtsEngine::resolve_spec(p).expect("应解析到 spec");
        assert_eq!(spec.id, "sherpa-onnx-zipvoice-distill");
    }

    #[test]
    fn test_resolve_spec_unknown() {
        let p = Path::new("models/bogus/model.onnx");
        assert!(SherpaTtsEngine::resolve_spec(p).is_none());
    }
}
