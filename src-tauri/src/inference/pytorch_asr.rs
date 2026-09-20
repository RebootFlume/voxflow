//! PyTorch ASR 适配器：把 `AsrEngine` 契约映射到 Python worker 的 JSON 协议。
//!
//! 职责边界：
//! - 只做"契约翻译"：模型解析（查描述符）→ 选运行时（按设备）→ 起 worker → 传 WAV 路径；
//! - 不感知具体模型架构（whisper 的加载与解码都在 worker 内的白名单适配器里）；
//! - 音频以临时 WAV 交给 worker（首版约定），避免二进制帧协议与 torchaudio 依赖。

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;

use super::engine::AsrEngine;
use super::pytorch::PyTorchWorker;
use crate::tts::spec::{BackendSpec, ModelKind, ModelSpec, PyTorchSpec};

struct Inner {
    worker: Option<PyTorchWorker>,
    model: String,
    device: String,
    model_dir: PathBuf,
    adapter: &'static str,
    language: &'static str,
}

pub struct PyTorchAsrAdapter {
    inner: Mutex<Inner>,
    /// 峰值显存估算用的最近一次加载信息
    vram_hint_mb: Mutex<Option<u64>>,
}

impl Default for PyTorchAsrAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl PyTorchAsrAdapter {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                worker: None,
                model: String::new(),
                device: String::new(),
                model_dir: PathBuf::new(),
                adapter: "",
                language: "",
            }),
            vram_hint_mb: Mutex::new(None),
        }
    }

    /// 从描述符取 PyTorch 后端参数（非 PyTorch 模型 → 明确报错，不做猜测）
    fn backend_of(name: &str) -> Result<(&'static ModelSpec, PyTorchSpec), String> {
        let spec = ModelSpec::find(name).ok_or_else(|| format!("未知模型: {name}"))?;
        if spec.kind != ModelKind::Asr {
            return Err(format!("{name} 不是 ASR 模型"));
        }
        match spec.backend {
            BackendSpec::PyTorch(p) => Ok((spec, p)),
            _ => Err(format!("{name} 不是 PyTorch 模型")),
        }
    }

    fn load(&self, name: &str, device: &str, on_stage: &mut dyn FnMut(&str)) -> Result<(), String> {
        let (spec, backend) = Self::backend_of(name)?;
        let dir = crate::model_manager::model_dir(spec.name);
        if !dir.is_dir() {
            return Err(format!("模型 {} 尚未下载: {}", spec.name, dir.display()));
        }
        // 主权重必须存在（缺文件时给明确提示，而不是等 worker 报错）
        if crate::model_manager::main_model_file(spec, &dir).is_none() {
            return Err(format!("{} 缺少主模型文件（下载未完成？）", spec.name));
        }
        on_stage("loading");
        let mut inner = self.inner.lock();
        // 幂等：同模型 + 同设备直接复用（worker 内部也会判重，这里省一次 IPC）
        if inner.model == spec.name && inner.device == device && inner.worker.is_some() {
            on_stage("ready");
            return Ok(());
        }
        // 先卸旧进程：换设备/换模型时必须释放显存与 DLL
        if let Some(worker) = inner.worker.take() {
            worker.shutdown();
        }
        let worker = PyTorchWorker::new(device)?;
        worker
            .load_model(&dir, backend.adapter, &backend.language, "")
            .map_err(|e| format!("{} 加载失败: {e}", spec.name))?;
        inner.worker = Some(worker);
        inner.model = spec.name.to_string();
        inner.device = device.to_string();
        inner.model_dir = dir;
        inner.adapter = backend.adapter;
        inner.language = backend.language;
        *self.vram_hint_mb.lock() = None;
        on_stage("ready");
        Ok(())
    }
}

impl AsrEngine for PyTorchAsrAdapter {
    fn framework(&self) -> &'static str {
        "pytorch"
    }

    fn load_model(&self, name: &str) -> Result<(), String> {
        self.load(name, "cuda", &mut |_| {})
    }

    fn load_model_with_device(&self, name: &str, device: &str) -> Result<(), String> {
        self.load(name, device, &mut |_| {})
    }

    fn load_model_with_stage(&self, name: &str, on_stage: &mut dyn FnMut(&str)) -> Result<(), String> {
        self.load(name, "cuda", on_stage)
    }

    fn load_model_with_stage_and_device(
        &self,
        name: &str,
        device: &str,
        on_stage: &mut dyn FnMut(&str),
    ) -> Result<(), String> {
        self.load(name, device, on_stage)
    }

    fn unload(&self) -> Result<(), String> {
        let mut inner = self.inner.lock();
        if let Some(worker) = inner.worker.take() {
            worker.shutdown();
        }
        inner.model.clear();
        inner.device.clear();
        inner.model_dir = PathBuf::new();
        Ok(())
    }

    fn is_loaded(&self) -> bool {
        let inner = self.inner.lock();
        inner.worker.as_ref().is_some_and(|w| w.is_running())
    }

    fn current_model(&self) -> String {
        let inner = self.inner.lock();
        if inner.worker.is_none() {
            return String::new();
        }
        inner.model.clone()
    }

    fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String, String> {
        self.transcribe_with_context(samples, sample_rate, "")
    }

    fn transcribe_with_context(
        &self,
        samples: &[f32],
        sample_rate: u32,
        ctx: &str,
    ) -> Result<String, String> {
        let inner = self.inner.lock();
        let worker = inner
            .worker
            .as_ref()
            .ok_or_else(|| "PyTorch 模型未加载".to_string())?;
        let wav = write_temp_wav(samples, sample_rate)?;
        let options = serde_json::json!({
            "language": inner.language,
            "context": ctx,
        });
        let result = worker.transcribe(&wav, options);
        let _ = std::fs::remove_file(&wav);
        let value = result?;
        Ok(value
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string())
    }

    fn vram_estimate_mb(&self) -> Option<u64> {
        let inner = self.inner.lock();
        // CPU 模式不占显存；CUDA 模式按"模型目录体积 + 运行时开销"粗估（权重常驻）
        if inner.device != "cuda" || inner.worker.is_none() {
            return None;
        }
        if let Some(v) = *self.vram_hint_mb.lock() {
            return Some(v);
        }
        let bytes = dir_size(&inner.model_dir);
        if bytes == 0 {
            return None;
        }
        let mb = (bytes / (1024 * 1024)) + 600; // + 运行时/CUDA 上下文固定开销
        *self.vram_hint_mb.lock() = Some(mb);
        Some(mb)
    }

    fn pid(&self) -> Option<u32> {
        self.inner.lock().worker.as_ref().and_then(|w| w.pid())
    }
}

fn dir_size(dir: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(md) = e.metadata() {
                total += md.len();
            }
        }
    }
    total
}

/// 写临时 16-bit PCM WAV（worker 侧按需线性重采样）。
/// 用系统临时目录 + 进程内自增序号，避免并发转写互相覆盖。
pub fn write_temp_wav(samples: &[f32], sample_rate: u32) -> Result<PathBuf, String> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "voxflow-pytorch-{}-{seq}.wav",
        std::process::id()
    ));
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: sample_rate.max(1),
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&path, spec)
        .map_err(|e| format!("写临时 WAV 失败: {e}"))?;
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer.write_sample(v).map_err(|e| format!("写临时 WAV 失败: {e}"))?;
    }
    writer.finalize().map_err(|e| format!("写临时 WAV 失败: {e}"))?;
    Ok(path)
}

/// 便捷构造：注册表用（`Arc<dyn AsrEngine>`）
pub fn shared() -> Arc<dyn AsrEngine> {
    Arc::new(PyTorchAsrAdapter::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backend_lookup_rejects_non_pytorch() {
        let err = PyTorchAsrAdapter::backend_of("Qwen3-ASR-0.6B").unwrap_err();
        assert!(err.contains("不是 PyTorch 模型"), "{err}");
        let err = PyTorchAsrAdapter::backend_of("Kokoro-82M-PT").unwrap_err();
        assert!(err.contains("不是 ASR"), "{err}");
    }

    #[test]
    fn test_backend_lookup_accepts_whisper_spec() {
        let (spec, backend) = PyTorchAsrAdapter::backend_of("Whisper-tiny-PT").unwrap();
        assert_eq!(spec.framework, "pytorch");
        assert_eq!(backend.adapter, "whisper");
        assert_eq!(backend.language, "zh");
    }

    #[test]
    fn test_write_temp_wav_roundtrip() {
        let samples = vec![0.0f32, 0.5, -0.5, 1.0, -1.0];
        let path = write_temp_wav(&samples, 16000).unwrap();
        let mut reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.spec().sample_rate, 16000);
        assert_eq!(reader.spec().channels, 1);
        let got: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
        assert_eq!(got.len(), samples.len());
        assert!(got[1] > 16000 && got[2] < -16000);
        let _ = std::fs::remove_file(&path);
    }
}
