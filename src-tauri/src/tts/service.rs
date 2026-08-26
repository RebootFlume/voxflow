//! TTS 统一调度 Service（端到端 / E2E）
//!
//! 负责：manifest 加载、session 构建、E2E 文本分词器、voice 管理、状态机。
//! 管道即「纯文本 → token ids → 端到端模型推理 → 波形」，
//! 无音素 / G2P、无语速、无时长预测、无重采样/拉伸后处理。
//! 具体模型差异全部收敛在 `ModelManifest` 配置中，本 Service 不含模型特例。

use std::path::{Path, PathBuf};

use super::config::ModelManifest;
use super::engine::onnx::GenericOnnxEngine;
use super::engine::sherpa::SherpaTtsEngine;
use super::tokenizer::TextTokenizer;
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
    tokenizer: TextTokenizer,
    voice_embedding: Vec<f32>,
    language: String,
    /// VITS 后端（sherpa-onnx 子进程）；当加载 VITS 模型时使用
    sherpa: Option<SherpaTtsEngine>,
}

impl TtsService {
    pub fn new() -> Self {
        Self {
            state: ServiceState::Uninitialized,
            model_root: None,
            engine: None,
            manifest: None,
            tokenizer: TextTokenizer::new(),
            voice_embedding: Vec::new(),
            language: String::new(),
            sherpa: None,
        }
    }

    pub fn state(&self) -> &ServiceState {
        &self.state
    }

    /// 装载 E2E 文本分词器（tokenizer.json 的 model.vocab）
    fn load_tokenizer(&mut self, model_root: &Path, manifest: &ModelManifest) {
        let Some(tok_file) = &manifest.tokenizer_file else {
            eprintln!("[tts] WARNING: no tokenizer_file in manifest");
            return;
        };
        self.tokenizer.load_tokenizer(model_root, tok_file);
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

impl TtsService {
    /// 获取底层 sherpa 引擎的可变引用（供语音克隆等操作）
    /// 仅在已加载 sherpa 模型时返回 Some
    pub fn as_mut_sherpa(&mut self) -> Option<&mut SherpaTtsEngine> {
        self.sherpa.as_mut()
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

        // 定位模型根目录
        let model_root = ModelManifest::resolve_model_root(model_path);

        // E2E 模型（kokoro/matcha/zipvoice/pocket/supertonic/kitten）→ sherpa-onnx 子进程后端
        // VITS 模型（vits-*.onnx / rule.far 存在）→ 同样走 sherpa-onnx（音素由 CLI 内部处理）
        let file_name = model_path
            .file_name()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let is_e2e = [
            "kokoro", "matcha", "zipvoice", "pocket", "supertonic", "kitten",
        ]
        .iter()
        .any(|k| file_name.contains(k) || model_path.to_string_lossy().to_lowercase().contains(k));
        if is_e2e || file_name.starts_with("vits-") || model_root.join("rule.far").exists() {
            eprintln!("[tts] detected sherpa-onnx model (E2E or VITS), using sherpa-onnx backend");
            let mut vits = SherpaTtsEngine::new();
            vits.load(model_path, _device)?;
            let mut model_name = vits.name().to_string();
            if model_name.is_empty() {
                // 回退：VITS 用文件名
                model_name = model_path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "VITS".into());
            }
            self.sherpa = Some(vits);
            self.model_root = Some(model_root);
            self.manifest = None;
            self.engine = None;
            self.language = "zh".to_string();
            self.state = ServiceState::Ready { model_name };
            return Ok(());
        }

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

        // E2E 文本分词器
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
        self.sherpa = None;
        self.tokenizer = TextTokenizer::new();
        self.voice_embedding.clear();
        self.language.clear();
        self.state = ServiceState::Uninitialized;
        Ok(())
    }

    fn is_loaded(&self) -> bool {
        matches!(self.state, ServiceState::Ready { .. })
    }

    fn set_language(&mut self, language: &str) -> TtsResult<()> {
        // VITS 后端：只支持中文，委托给 sherpa 引擎
        if let Some(vits) = self.sherpa.as_mut() {
            vits.set_language(language)?;
            self.language = language.to_string();
            return Ok(());
        }
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

    /// 端到端合成：纯文本 → token ids → 模型推理 → 24kHz i16 PCM
    fn infer(&mut self, text: &str, _voice: &str) -> TtsResult<Vec<i16>> {
        if !self.is_loaded() {
            return Err(AppError::NotInitialized);
        }
        if text.is_empty() {
            return Ok(Vec::new());
        }

        // 1. E2E 文本分词（无音素 / G2P）
        // VITS 后端：直接交给 sherpa-onnx 子进程（内部处理音素）
        if let Some(vits) = self.sherpa.as_mut() {
            return vits.infer(text, _voice);
        }
        let token_ids = self.tokenizer.encode(text);
        eprintln!(
            "[tts] text='{}' token_ids(len={}) first={:?}",
            text.chars().take(80).collect::<String>(),
            token_ids.len(),
            token_ids.iter().take(6).collect::<Vec<_>>()
        );
        if token_ids.is_empty() {
            return Err(AppError::InvalidInput(
                "no token ids produced for this text — tokenizer vocab does not cover it".to_string(),
            ));
        }
        let mut token_ids = token_ids;
        if token_ids.len() % 2 != 0 {
            token_ids.push(0);
        }

        // 2. 推理（engine 按 manifest 组装张量）
        let engine = self.engine.as_mut().ok_or(AppError::NotInitialized)?;
        let style: Option<&[f32]> = Some(&self.voice_embedding);
        let audio_f32 = engine.run(&token_ids, style)?;

        // 3. float32 → int16（24kHz，直线输出，无重采样/拉伸后处理）
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
        assert!(matches!(s.infer("hello", "af"), Err(AppError::NotInitialized)));
    }
}
