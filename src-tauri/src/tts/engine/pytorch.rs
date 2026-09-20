//! PyTorch TTS 引擎：把 `TtsEngine` 契约映射到 Python worker 的合成命令。
//!
//! 与 sherpa 引擎的差别只在"参数怎么传"：sherpa 是命令行子进程，这里是长驻 Python worker
//! 的 JSON 命令；模型目录只提供权重与配置，G2P 与声码器都在运行时内置的适配器里。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;

use super::super::traits::{SynthAudio, TtsEngine, TtsResult};
use crate::errors::AppError;
use crate::inference::pytorch::PyTorchWorker;
use crate::tts::spec::{BackendSpec, ModelKind, ModelSpec, PyTorchSpec};

struct Inner {
    worker: Option<PyTorchWorker>,
    /// 已加载模型描述符（`id`/`name` 都是 `&'static str`，`name()` 直接返回静态 id，无需泄漏字符串）
    spec: Option<&'static ModelSpec>,
    device: String,
    model_dir: PathBuf,
    language: &'static str,
    default_voice: &'static str,
}

pub struct PyTorchTtsEngine {
    inner: Mutex<Inner>,
}

impl Default for PyTorchTtsEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PyTorchTtsEngine {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                worker: None,
                spec: None,
                device: String::new(),
                model_dir: PathBuf::new(),
                language: "zh",
                default_voice: "",
            }),
        }
    }

    /// 由主模型文件路径反查描述符（registry 传的是 `main_model_file`）
    fn spec_for(model_path: &Path) -> TtsResult<(&'static ModelSpec, PyTorchSpec)> {
        let dir = model_path.parent().unwrap_or(model_path);
        let name = dir
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let spec = ModelSpec::find(&name)
            .ok_or_else(|| AppError::LoadFailed(format!("无法识别 PyTorch TTS 模型目录: {name}")))?;
        if spec.kind != ModelKind::Tts {
            return Err(AppError::LoadFailed(format!("{} 不是 TTS 模型", spec.name)));
        }
        match spec.backend {
            BackendSpec::PyTorch(p) => Ok((spec, p)),
            _ => Err(AppError::LoadFailed(format!("{} 不是 PyTorch 模型", spec.name))),
        }
    }
}

impl TtsEngine for PyTorchTtsEngine {
    fn name(&self) -> &str {
        // spec.id 是 &'static str：生命周期来自静态数据，不来自锁守卫，也无需任何泄漏
        self.inner.lock().spec.map(|s| s.id).unwrap_or("")
    }

    fn load(&self, model_path: &Path, device: &str) -> TtsResult<()> {
        let (spec, backend) = Self::spec_for(model_path)?;
        let dir = model_path
            .parent()
            .ok_or_else(|| AppError::LoadFailed("PyTorch 模型路径没有父目录".into()))?
            .to_path_buf();
        if crate::model_manager::main_model_file(spec, &dir).is_none() {
            return Err(AppError::LoadFailed(format!(
                "{} 缺少主模型文件（下载未完成？）",
                spec.name
            )));
        }
        let mut inner = self.inner.lock();
        if inner.spec.is_some_and(|s| s.id == spec.id)
            && inner.device == device
            && inner.worker.is_some()
        {
            return Ok(());
        }
        if let Some(worker) = inner.worker.take() {
            worker.shutdown();
        }
        let worker = PyTorchWorker::new(device).map_err(AppError::LoadFailed)?;
        worker
            .load_model(&dir, backend.adapter, backend.language, backend.voice)
            .map_err(AppError::LoadFailed)?;
        inner.worker = Some(worker);
        inner.spec = Some(spec);
        inner.device = device.to_string();
        inner.model_dir = dir;
        inner.language = backend.language;
        inner.default_voice = backend.voice;
        Ok(())
    }

    fn unload(&self) -> TtsResult<()> {
        let mut inner = self.inner.lock();
        if let Some(worker) = inner.worker.take() {
            worker.shutdown();
        }
        inner.spec = None;
        inner.device.clear();
        inner.model_dir = PathBuf::new();
        Ok(())
    }

    fn is_loaded(&self) -> bool {
        let inner = self.inner.lock();
        inner.worker.as_ref().is_some_and(|w| w.is_running())
    }

    fn set_language(&self, language: &str) -> TtsResult<()> {
        let inner = self.inner.lock();
        let want = language.trim().to_ascii_lowercase();
        if inner.language.is_empty() || want == inner.language {
            return Ok(());
        }
        // 单语模型：明确拒绝而不是静默按别的语言合成
        Err(AppError::InvalidInput(format!(
            "当前 PyTorch TTS 模型只支持 {}",
            inner.language
        )))
    }

    fn synthesize(&self, text: &str, voice: &str) -> TtsResult<SynthAudio> {
        let inner = self.inner.lock();
        let worker = inner
            .worker
            .as_ref()
            .ok_or_else(|| AppError::InvalidInput("PyTorch TTS 模型未加载".into()))?;
        // 音色：显式指定且模型目录里有该音色 → 用它；否则回落描述符默认音色
        let picked = if !voice.trim().is_empty()
            && inner.model_dir.join("voices").join(format!("{voice}.pt")).is_file()
        {
            voice.trim().to_string()
        } else {
            inner.default_voice.to_string()
        };
        let out = std::env::temp_dir().join(format!(
            "voxflow-kokoro-{}-{}.wav",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        let options = serde_json::json!({ "voice": picked, "speed": 1.0, "language": inner.language });
        let result = worker.synthesize(text, &out, options);
        let value = match result {
            Ok(v) => v,
            Err(e) => {
                let _ = std::fs::remove_file(&out);
                return Err(AppError::InferenceFailed(e));
            }
        };
        let rate = value
            .get("sample_rate")
            .and_then(|v| v.as_u64())
            .unwrap_or(24000) as u32;
        let samples = read_wav_i16(&out);
        let _ = std::fs::remove_file(&out);
        let samples = samples.map_err(AppError::InferenceFailed)?;
        if samples.is_empty() {
            return Err(AppError::InferenceFailed("合成结果为空".into()));
        }
        Ok(SynthAudio { samples, sample_rate: rate })
    }

    fn vram_estimate_mb(&self) -> Option<u64> {
        let inner = self.inner.lock();
        if inner.device != "cuda" || inner.worker.is_none() {
            return None;
        }
        // Kokoro 权重约 320MB + 运行时/CUDA 上下文开销
        Some(320 + 600)
    }
}

fn read_wav_i16(path: &Path) -> Result<Vec<i16>, String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| format!("读合成 WAV 失败: {e}"))?;
    if reader.spec().bits_per_sample != 16 {
        return Err(format!(
            "合成 WAV 位深异常: {}",
            reader.spec().bits_per_sample
        ));
    }
    reader
        .samples::<i16>()
        .collect::<Result<Vec<i16>, _>>()
        .map_err(|e| format!("解析合成 WAV 失败: {e}"))
}

/// 注册表用
pub fn shared() -> Arc<dyn TtsEngine> {
    Arc::new(PyTorchTtsEngine::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spec_lookup_rejects_unknown_dir() {
        let err = PyTorchTtsEngine::spec_for(Path::new("D:/nope/unknown-model/model.pth")).unwrap_err();
        assert!(err.to_string().contains("无法识别"), "{err}");
    }

    #[test]
    fn test_spec_lookup_accepts_kokoro_dir() {
        let (spec, backend) = PyTorchTtsEngine::spec_for(Path::new("D:/m/kokoro-82m-pt/kokoro-v1_0.pth")).unwrap();
        assert_eq!(spec.name, "Kokoro-82M-PT");
        assert_eq!(backend.adapter, "kokoro");
        assert_eq!(backend.voice, "zf_xiaobei");
    }

    #[test]
    fn test_spec_lookup_rejects_asr_dir() {
        let err = PyTorchTtsEngine::spec_for(Path::new("D:/m/whisper-tiny-pt/model.safetensors")).unwrap_err();
        assert!(err.to_string().contains("不是 TTS 模型"), "{err}");
    }

    #[test]
    fn test_synthesize_without_model_reports_clear_error() {
        let engine = PyTorchTtsEngine::new();
        assert!(!engine.is_loaded());
        let err = engine.synthesize("你好", "").unwrap_err();
        assert!(err.to_string().contains("未加载"), "{err}");
    }
}
