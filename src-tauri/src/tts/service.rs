//! TTS 统一调度 Service
//!
//! 负责：manifest 加载、session 构建、tokenizer vocab、voice 管理、
//! 管道分发（Phoneme / Direct）、状态机。
//! 具体模型差异全部收敛在 `ModelManifest` 配置中，本 Service 不含模型特例。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::config::{ModelManifest, PipelineType};
use super::engine::onnx::GenericOnnxEngine;
use super::middleware::{direct_tokenizer, PhonemizerRouter};
use super::traits::{TtsEngine, TtsResult};
use crate::errors::AppError;

/// Service 状态
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceState {
    Uninitialized,
    Loading,
    Ready { model_name: String },
    Error(String),
}

/// TTS 统一调度器（命令层通过 `TtsEngine` trait 访问）
pub struct TtsService {
    state: ServiceState,
    model_root: Option<PathBuf>,
    engine: Option<GenericOnnxEngine>,
    manifest: Option<ModelManifest>,
    phonemizer: PhonemizerRouter,
    phoneme_to_id: HashMap<String, u32>,
    voice_embedding: Vec<f32>,
    language: String,
}

impl TtsService {
    pub fn new() -> Self {
        Self {
            state: ServiceState::Uninitialized,
            model_root: None,
            engine: None,
            manifest: None,
            phonemizer: PhonemizerRouter::new(),
            phoneme_to_id: HashMap::new(),
            voice_embedding: Vec::new(),
            language: String::new(),
        }
    }

    pub fn state(&self) -> &ServiceState {
        &self.state
    }

    /// 从 tokenizer.json 的 model.vocab 装载 phoneme → id 映射
    fn load_tokenizer(&mut self, model_root: &Path, manifest: &ModelManifest) {
        let Some(tok_file) = &manifest.tokenizer_file else {
            eprintln!("[tts] WARNING: no tokenizer_file in manifest");
            return;
        };
        let p = model_root.join(tok_file);
        let Ok(data) = std::fs::read_to_string(&p) else {
            eprintln!("[tts] WARNING: failed to read tokenizer {}", p.display());
            return;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
            eprintln!("[tts] WARNING: failed to parse tokenizer {}", p.display());
            return;
        };
        let Some(vocab) = v.get("model").and_then(|m| m.get("vocab")).and_then(|v| v.as_object()) else {
            eprintln!("[tts] WARNING: no model.vocab in tokenizer");
            return;
        };
        self.phoneme_to_id.clear();
        for (k, val) in vocab {
            if let Some(id) = val.as_u64() {
                self.phoneme_to_id.insert(k.clone(), id as u32);
            }
        }
        eprintln!("[tts] loaded {} phoneme mappings", self.phoneme_to_id.len());
    }

    /// 从磁盘读取 voice embedding，兼容裸 f32（af.bin）与 torch ZIP（zf_*.pt）
    fn decode_voice_file(path: &Path, out: &mut Vec<f32>) -> Result<(), AppError> {
        let data = std::fs::read(path).map_err(|e| AppError::LoadFailed(format!("read voice: {e}")))?;
        let mut loaded: Option<Vec<f32>> = None;
        // 裸 f32（af.bin 场景：512KB）
        if data.len() % 4 == 0 {
            let f: Vec<f32> = data
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            let is_zip = data.starts_with(&[0x50, 0x4B, 0x03, 0x04]); // PK header = torch save
            if !is_zip && f.len() >= 256 && f.iter().all(|v| v.is_finite()) {
                loaded = Some(f);
            }
        }
        // torch ZIP/pickle 场景：扫描连续 f32 块
        if loaded.is_none() {
            let mut best: Vec<f32> = Vec::new();
            let mut cur: Vec<f32> = Vec::new();
            for chunk in data.chunks_exact(4) {
                let v = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                if v.is_finite() && v.abs() < 10.0 {
                    cur.push(v);
                } else if cur.len() >= 256 {
                    if cur.len() > best.len() {
                        best = cur.clone();
                    }
                    cur.clear();
                } else {
                    cur.clear();
                }
            }
            if cur.len() > best.len() {
                best = cur;
            }
            if best.len() >= 256 {
                loaded = Some(best);
            }
        }
        let f = loaded.ok_or_else(|| AppError::LoadFailed("decode voice file".to_string()))?;
        *out = f[..256.min(f.len())].to_vec();
        if out.len() < 256 {
            out.resize(256, 0.0);
        }
        Ok(())
    }

    /// 装载某语言的 voice embedding（失败回退零向量并告警）
    fn load_voice(&mut self, lang: &str) {
        let (model_root, manifest) = match (&self.model_root, &self.manifest) {
            (Some(r), Some(m)) => (r.clone(), m.clone()),
            _ => return,
        };
        let voice_file = manifest.voice_path(&model_root, lang);
        let mut buf: Vec<f32> = Vec::new();
        if Self::decode_voice_file(&voice_file, &mut buf).is_ok() && buf.len() >= 256 {
            self.voice_embedding = buf[..256].to_vec();
            eprintln!("[tts] voice embedding loaded: {} floats ({})", buf.len(), voice_file.display());
        } else {
            eprintln!("[tts] WARNING: failed to decode voice file {:?}", voice_file);
            self.voice_embedding = vec![0.0; 256];
        }
    }
}

impl Default for TtsService {
    fn default() -> Self {
        Self::new()
    }
}

impl TtsEngine for TtsService {
    fn name(&self) -> &str {
        match &self.state {
            ServiceState::Ready { model_name } => model_name.as_str(),
            _ => "",
        }
    }

    fn load(&mut self, model_path: &Path, _device: &str) -> TtsResult<()> {
        self.state = ServiceState::Loading;
        if !model_path.exists() {
            self.state = ServiceState::Error(format!("not found: {}", model_path.display()));
            return Err(AppError::ModelNotFound(model_path.display().to_string()));
        }

        // 定位模型根目录 + 加载 manifest
        let model_root = ModelManifest::resolve_model_root(model_path);
        let manifest = ModelManifest::load(&model_root)?;

        // 构建 ONNX session
        let session = ort::session::Session::builder()
            .map_err(|e| AppError::LoadFailed(format!("builder: {e}")))?
            .commit_from_file(model_path)
            .map_err(|e| AppError::LoadFailed(format!("load: {e}")))?;
        eprintln!("[tts] model loaded: {}", model_path.display());
        for inp in session.inputs() {
            eprintln!("[tts] input: {}", inp.name());
        }
        for out in session.outputs() {
            eprintln!("[tts] output: {}", out.name());
        }

        self.model_root = Some(model_root.clone());
        self.manifest = Some(manifest.clone());
        self.engine = Some(GenericOnnxEngine::new(session, manifest.clone()));

        // tokenizer vocab
        self.load_tokenizer(&model_root, &manifest);

        // 默认语言（有 zh 则 zh，否则 en）→ 默认 voice
        let default_lang = if manifest.voices.contains_key("zh") { "zh" } else { "en" };
        self.language = default_lang.to_string();
        self.load_voice(default_lang);

        let model_name = model_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| manifest.id.clone());
        self.state = ServiceState::Ready { model_name };
        Ok(())
    }

    fn unload(&mut self) -> TtsResult<()> {
        self.engine = None;
        self.manifest = None;
        self.model_root = None;
        self.phoneme_to_id.clear();
        self.voice_embedding.clear();
        self.language.clear();
        self.state = ServiceState::Uninitialized;
        Ok(())
    }

    fn is_loaded(&self) -> bool {
        matches!(self.state, ServiceState::Ready { .. })
    }

    fn set_language(&mut self, language: &str) -> TtsResult<()> {
        let (model_root, manifest) = match (&self.model_root, &self.manifest) {
            (Some(r), Some(m)) => (r.clone(), m.clone()),
            _ => return Err(AppError::NotInitialized),
        };
        // 严格校验：该语言必须在 manifest.voices 中配置且文件存在，禁止静默回退到其它口音
        let Some(rel) = manifest.voices.get(language) else {
            return Err(AppError::ModelNotFound(format!(
                "no voice available for language '{language}' (available: {})",
                manifest.voices.keys().cloned().collect::<Vec<_>>().join(", ")
            )));
        };
        let voice_file = model_root.join(rel);
        if !voice_file.exists() {
            return Err(AppError::ModelNotFound(voice_file.display().to_string()));
        }
        let mut out: Vec<f32> = Vec::new();
        Self::decode_voice_file(&voice_file, &mut out)?;
        self.voice_embedding = out;
        self.language = language.to_string();
        eprintln!("[tts] switch language: {language} voice={}", voice_file.display());
        Ok(())
    }

    fn infer(&mut self, text: &str, _voice: &str, rate: f64) -> TtsResult<Vec<i16>> {
        if !self.is_loaded() {
            return Err(AppError::NotInitialized);
        }
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let manifest = self.manifest.as_ref().ok_or(AppError::NotInitialized)?;

        // 1. 按管道类型生成 token ids
        let token_ids = match manifest.pipeline_type {
            PipelineType::Phoneme => self.phonemizer.to_token_ids(text, &self.phoneme_to_id),
            PipelineType::Direct => direct_tokenizer::direct_tokenize(text, &self.phoneme_to_id)?,
        };
        let has_content = token_ids.len() > 2; // 仅有首尾边界 $ 不算内容
        eprintln!(
            "[tts] text='{}' token_ids(len={}) has_content={} first={:?}",
            text.chars().take(80).collect::<String>(),
            token_ids.len(),
            has_content,
            token_ids.iter().take(6).collect::<Vec<_>>()
        );
        if !has_content {
            return Err(AppError::G2pFailed(
                "phoneme encoding is empty for this language — G2P produced no phonemes \
                 (English uses passthrough; Chinese needs the pinyin fallback)"
                    .to_string(),
            ));
        }
        let mut token_ids = token_ids;
        if token_ids.len() % 2 != 0 {
            token_ids.push(0);
        }

        // 2. 推理（engine 按 manifest 组装张量）
        let engine = self.engine.as_mut().ok_or(AppError::NotInitialized)?;
        let style: Option<&[f32]> = Some(&self.voice_embedding);
        let speed = rate.clamp(0.5, 2.0) as f32;
        let audio_f32 = engine.run(&token_ids, style, Some(speed))?;

        // 3. float32 → int16（24kHz）
        let samples: Vec<i16> = audio_f32
            .iter()
            .map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect();
        Ok(samples)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_service_uninitialized() {
        let s = TtsService::new();
        assert!(!s.is_loaded());
        assert_eq!(s.name(), "");
        assert_eq!(s.state(), &ServiceState::Uninitialized);
    }

    #[test]
    fn test_infer_before_load_errors() {
        let mut s = TtsService::new();
        assert!(matches!(s.infer("hello", "af", 1.0), Err(AppError::NotInitialized)));
    }
}
