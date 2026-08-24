//! ModelManifest：模型元数据配置（JSON）
//!
//! 模型差异 → 配置，而非代码。新模型无需改动 Rust 源码：
//! 在模型目录放一份 `manifest.json`，或落到统一 ONNX 布局的自动探测。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::errors::AppError;

/// 管道类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PipelineType {
    /// A 轨：文本直接 tokenizer 化（Qwen-TTS / Chatterbox 等）
    Direct,
    /// B 轨：G2P（espeak-ng）→ IPA → vocab 映射（Kokoro / LuxTTS 等）
    Phoneme,
}

/// 张量数据类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dtype {
    I64,
    F32,
}

/// 张量角色描述：语义角色（tokens/style/speed）→ 节点名 + 数据类型
#[derive(Debug, Clone, Deserialize)]
pub struct TensorSpec {
    pub name: String,
    pub dtype: Dtype,
}

/// 模型输入张量定义（`style`/`speed` 可选：缺省即不绑定该张量）
#[derive(Debug, Clone, Deserialize)]
pub struct ModelInputs {
    pub tokens: TensorSpec,
    pub style: Option<TensorSpec>,
    pub speed: Option<TensorSpec>,
}

/// 模型清单（manifest.json）
#[derive(Debug, Clone, Deserialize)]
pub struct ModelManifest {
    pub id: String,
    pub pipeline_type: PipelineType,
    /// 模型文件（相对模型目录，如 "onnx/model.onnx"）
    pub model_file: String,
    /// tokenizer/vocab 文件（相对模型目录，如 "tokenizer.json"）
    pub tokenizer_file: Option<String>,
    pub sample_rate: u32,
    pub inputs: ModelInputs,
    /// 输出候选节点名（按序取第一个存在者）
    #[serde(default)]
    pub outputs: Vec<String>,
    /// 语言 → voice 文件（相对模型目录）
    #[serde(default)]
    pub voices: HashMap<String, String>,
}

const MANIFEST_NAMES: &[&str] = &["manifest.json", "kokoro.json"];

impl ModelManifest {
    /// 从模型目录加载 manifest；缺失时按标准 Kokoro 布局自动生成默认配置。
    pub fn load(model_root: &Path) -> Result<ModelManifest, AppError> {
        for name in MANIFEST_NAMES {
            let p = model_root.join(name);
            if p.exists() {
                let data = std::fs::read_to_string(&p)
                    .map_err(|e| AppError::LoadFailed(format!("read {name}: {e}")))?;
                let m: ModelManifest = serde_json::from_str(&data)
                    .map_err(|e| AppError::LoadFailed(format!("parse {name}: {e}")))?;
                eprintln!("[tts] manifest loaded from {name}: id={}", m.id);
                return Ok(m);
            }
        }
        Ok(Self::default_for(model_root))
    }

    /// 从模型文件路径向上定位模型根目录（含 tokenizer.json / manifest.json 的目录）
    pub fn resolve_model_root(model_file: &Path) -> PathBuf {
        let mut d = model_file.parent();
        for _ in 0..4 {
            let Some(dir) = d else { break };
            if dir.join("tokenizer.json").exists() || dir.join("manifest.json").exists() {
                return dir.to_path_buf();
            }
            d = dir.parent();
        }
        model_file.parent().unwrap_or(Path::new(".")).to_path_buf()
    }

    /// 解析某语言的 voice 文件路径；缺失/未配置时回退到任意已配置或 af.bin
    pub fn voice_path(&self, model_root: &Path, lang: &str) -> PathBuf {
        if let Some(rel) = self.voices.get(lang) {
            let p = model_root.join(rel);
            if p.exists() {
                return p;
            }
        }
        self.voices
            .values()
            .find(|rel| model_root.join(rel).exists())
            .map(|rel| model_root.join(rel))
            .unwrap_or_else(|| model_root.join("voices/af.bin"))
    }

    /// 无 manifest 时的默认配置：标准 Kokoro-82M ONNX 布局 + voices 目录自动探测
    fn default_for(model_root: &Path) -> ModelManifest {
        let model_file = crate::model_manager::find_main_model_file(
            model_root,
            &crate::model_manager::ModelFormat::Onnx,
        )
        .and_then(|p| p.strip_prefix(model_root).ok().map(|r| r.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "onnx/model.onnx".to_string());
        let tokenizer_file = model_root
            .join("tokenizer.json")
            .exists()
            .then(|| "tokenizer.json".to_string());
        let voices = scan_voices(model_root);
        let id = model_root
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "onnx-tts".to_string());
        eprintln!(
            "[tts] no manifest.json, using default Kokoro layout (id={id} model_file={model_file} voices={})",
            voices.len()
        );
        ModelManifest {
            id,
            pipeline_type: PipelineType::Phoneme,
            model_file,
            tokenizer_file,
            sample_rate: 24000,
            inputs: ModelInputs {
                tokens: TensorSpec { name: "input_ids".into(), dtype: Dtype::I64 },
                style: Some(TensorSpec { name: "style".into(), dtype: Dtype::F32 }),
                speed: Some(TensorSpec { name: "speed".into(), dtype: Dtype::F32 }),
            },
            outputs: vec!["waveform".into(), "logits".into(), "audio_out".into(), "audio".into()],
            voices,
        }
    }
}

/// 扫描 `voices/` 目录，按文件名前缀归入语言（zf_/zm_→zh，jf_/jm_→ja，其余→en）
fn scan_voices(model_root: &Path) -> HashMap<String, String> {
    let mut voices: HashMap<String, String> = HashMap::new();
    let vdir = model_root.join("voices");
    if let Ok(rd) = std::fs::read_dir(&vdir) {
        let mut zh: Option<String> = None;
        let mut ja: Option<String> = None;
        let mut en: Option<String> = None;
        for e in rd.flatten() {
            let fname = e.file_name();
            let Some(n) = fname.to_str() else { continue };
            if !n.ends_with(".pt") && !n.ends_with(".bin") {
                continue;
            }
            let rel = format!("voices/{n}");
            if n.starts_with("zf_") || n.starts_with("zm_") {
                zh.get_or_insert(rel);
            } else if n.starts_with("jf_") || n.starts_with("jm_") {
                ja.get_or_insert(rel);
            } else {
                en.get_or_insert(rel);
            }
        }
        if let Some(v) = en {
            voices.insert("en".into(), v);
        }
        if let Some(v) = zh {
            voices.insert("zh".into(), v);
        }
        if let Some(v) = ja {
            voices.insert("ja".into(), v);
        }
    }
    voices
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_manifest_kokoro() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../models/Kokoro-82M");
        if !root.exists() {
            eprintln!("Kokoro model dir missing, skipping");
            return;
        }
        let m = ModelManifest::load(&root).unwrap();
        assert_eq!(m.pipeline_type, PipelineType::Phoneme);
        assert!(m.model_file.ends_with(".onnx"));
        assert_eq!(m.sample_rate, 24000);
        assert!(m.voices.contains_key("en"));
    }

    #[test]
    fn test_manifest_parse() {
        let json = r#"{
            "id": "test",
            "pipeline_type": "phoneme",
            "model_file": "model.onnx",
            "tokenizer_file": "tokenizer.json",
            "sample_rate": 24000,
            "inputs": {
                "tokens": { "name": "input_ids", "dtype": "i64" },
                "style": { "name": "style", "dtype": "f32" }
            },
            "outputs": ["logits"],
            "voices": { "en": "voices/af.bin" }
        }"#;
        let m: ModelManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.inputs.tokens.name, "input_ids");
        assert!(m.inputs.speed.is_none());
        assert_eq!(m.voices.get("en").unwrap(), "voices/af.bin");
    }
}
