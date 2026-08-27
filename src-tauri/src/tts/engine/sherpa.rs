//! sherpa-onnx E2E TTS 引擎（子进程模式）
//!
//! 架构：调用 `libs/sherpa-onnx/sherpa-onnx-offline-tts.exe` 子进程合成音频，
//! 与 ASR 的 llama-server 子进程一致 —— 推理框架与桌面应用进程隔离。
//!
//! 支持 6 个纯端到端模型（无音素 G2P 依赖）：
//!   Kokoro v1_1 / v1_0 / en-v0_19, Matcha, ZipVoice, Pocket TTS, Supertonic, Kitten
//!
//! VITS（音素模型，需要 lexicon + rule.far + tokens）不在本文件内，
//! 由 TtsService 根据模型目录自动识别后分派。
//!
//! 输出：WAV 文件 → 解码为 i16 PCM（24kHz）

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::errors::AppError;
use crate::tts::engine::e2e_registry::E2eTtsModel;
use crate::tts::traits::{TtsEngine, TtsResult};

/// sherpa-onnx E2E TTS 引擎
pub struct SherpaTtsEngine {
    /// 当前模型（None = 未加载）
    model: Option<E2eTtsModel>,
    /// 模型根目录（model_dir / default_dir / 各文件）
    model_root: PathBuf,
    /// 推理框架可执行文件路径
    tts_exe: PathBuf,
    /// 说话人 ID（Kokoro / Supertonic 等多说话人模型）
    sid: i32,
    /// 推理提供者（cpu / cuda）
    provider: String,
    /// 推理线程数（CPU 模式生效）
    num_threads: i32,
    /// 当前语言（Supertonic 等需 --lang 的模型使用）
    language: String,
    /// 语音克隆：参考音频路径（ZipVoice / PocketTTS 使用）
    reference_audio: Option<PathBuf>,
    /// 语音克隆：参考音频对应的文本（ZipVoice 需要）
    reference_text: Option<String>,
}

impl Default for SherpaTtsEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl SherpaTtsEngine {
    pub fn new() -> Self {
        // 模型根目录：统一数据根（get_model_root），无 workspace 回退
        let model_root = crate::model_manager::get_model_root();
        Self {
            model: None,
            model_root,
            tts_exe: crate::inference::runtime_paths::sherpa_runtime_dir()
                .join("sherpa-onnx-offline-tts.exe"),
            sid: 0,
            provider: "cuda".to_string(),
            num_threads: 4,
            language: "zh".to_string(),
            reference_audio: None,
            reference_text: None,
        }
    }

    /// 模型根目录下的模型目录路径
    fn model_dir(&self, m: E2eTtsModel) -> PathBuf {
        self.model_root.join(m.default_model_dir())
    }

    /// 检查推理框架与模型文件是否齐全
    fn check_ready(&self, m: E2eTtsModel) -> Result<(), AppError> {
        if !self.tts_exe.exists() {
            return Err(AppError::LoadFailed(format!(
                "sherpa-onnx TTS 推理框架不存在: {}",
                self.tts_exe.display()
            )));
        }
        let dir = self.model_dir(m);
        if !dir.exists() {
            return Err(AppError::LoadFailed(format!(
                "模型 {} 目录不存在: {}",
                m.id(),
                dir.display()
            )));
        }
        for f in required_files(m) {
            let p = dir.join(f);
            if !p.exists() {
                return Err(AppError::LoadFailed(format!(
                    "模型 {} 缺少文件: {}",
                    m.id(),
                    p.display()
                )));
            }
        }
        Ok(())
    }

    /// 根据模型类型生成 CLI 参数列表（不含 text 和 output-filename）
    fn cli_args(&self, m: E2eTtsModel) -> Vec<String> {
        let mut args: Vec<String> = Vec::new();
        let dir = self.model_dir(m);
        let join = |name: &str| dir.join(name).display().to_string();

        match m {
            E2eTtsModel::KokoroV1_1
            | E2eTtsModel::KokoroV1_0
            | E2eTtsModel::KokoroEn => {
                args.push(format!("--kokoro-model={}", join("model.onnx")));
                args.push(format!("--kokoro-voices={}", join("voices.bin")));
                args.push(format!("--kokoro-tokens={}", join("tokens.txt")));
                args.push(format!("--kokoro-data-dir={}", join("espeak-ng-data")));
                // 多词典（英文 + 中文），Kokoro 中英混说必需
                let lexicon = ["lexicon-us-en.txt", "lexicon-gb-en.txt", "lexicon-zh.txt"]
                    .iter()
                    .filter_map(|l| {
                        let p = dir.join(l);
                        p.exists().then(|| p.display().to_string())
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                if !lexicon.is_empty() {
                    args.push(format!("--kokoro-lexicon={lexicon}"));
                }
                // 中文数字/日期/电话归一化 FST（若存在）
                let fsts = ["date-zh.fst", "phone-zh.fst", "number-zh.fst"]
                    .iter()
                    .filter_map(|f| {
                        let p = dir.join(f);
                        p.exists().then(|| p.display().to_string())
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                if !fsts.is_empty() {
                    args.push(format!("--tts-rule-fsts={fsts}"));
                }
                args.push(format!("--sid={}", self.sid));
            }
            E2eTtsModel::Matcha => {
                // 主模型名可能是 model.onnx 或 model-steps-3.onnx（官方包）
                let acoustic = main_model_file(&dir);
                args.push(format!("--matcha-acoustic-model={}", acoustic.display()));
                args.push(format!("--matcha-tokens={}", join("tokens.txt")));
                args.push(format!("--matcha-data-dir={}", join("espeak-ng-data")));
                args.push(format!("--sid={}", self.sid));
            }
            E2eTtsModel::ZipVoice => {
                args.push(format!("--zipvoice-encoder={}", join("encoder.int8.onnx")));
                args.push(format!("--zipvoice-decoder={}", join("decoder.int8.onnx")));
                args.push(format!("--zipvoice-lexicon={}", join("lexicon.txt")));
                args.push(format!("--zipvoice-tokens={}", join("tokens.txt")));
                args.push(format!("--zipvoice-data-dir={}", join("espeak-ng-data")));
                // vocoder 单独下载，放在模型目录的父目录下（models/）
                let vocoder = self.model_root.join("vocos_24khz.onnx");
                args.push(format!("--zipvoice-vocoder={}", vocoder.display()));
                // 语音克隆：参考音频 + 参考文本
                if let Some(ref audio) = self.reference_audio {
                    args.push(format!("--reference-audio={}", audio.display()));
                }
                if let Some(ref text) = self.reference_text {
                    args.push(format!("--reference-text={text}"));
                }
            }
            E2eTtsModel::PocketTts => {
                args.push(format!("--pocket-lm-flow={}", join("lm_flow.int8.onnx")));
                args.push(format!("--pocket-lm-main={}", join("lm_main.int8.onnx")));
                args.push(format!("--pocket-encoder={}", join("encoder.onnx")));
                args.push(format!("--pocket-decoder={}", join("decoder.onnx")));
                args.push(format!("--pocket-tokens={}", join("tokens.txt")));
                args.push(format!("--pocket-data-dir={}", join("espeak-ng-data")));
            }
            E2eTtsModel::Supertonic => {
                // 官方参数（sherpa-onnx 1.3）：text-encoder / vector-estimator / vocoder / tts-json / unicode-indexer / voice-style
                args.push(format!(
                    "--supertonic-duration-predictor={}",
                    join("duration_predictor.int8.onnx")
                ));
                args.push(format!(
                    "--supertonic-text-encoder={}",
                    join("text_encoder.int8.onnx")
                ));
                args.push(format!(
                    "--supertonic-vector-estimator={}",
                    join("vector_estimator.int8.onnx")
                ));
                args.push(format!("--supertonic-vocoder={}", join("vocoder.int8.onnx")));
                args.push(format!("--supertonic-tts-json={}", join("tts.json")));
                args.push(format!("--supertonic-unicode-indexer={}", join("unicode_indexer.bin")));
                args.push(format!("--supertonic-voice-style={}", join("voice.bin")));
                args.push(format!("--sid={}", self.sid));
                // 语言由用户选择（31 语言），默认 zh
                let lang = if self.language.is_empty() { "zh" } else { &self.language };
                args.push(format!("--lang={lang}"));
            }
            E2eTtsModel::Kitten => {
                args.push(format!("--kitten-model={}", join("model.onnx")));
                args.push(format!("--kitten-tokens={}", join("tokens.txt")));
                args.push(format!("--sid={}", self.sid));
            }
        }

        // 通用参数
        args.push(format!("--provider={}", self.provider));
        args.push(format!("--num-threads={}", self.num_threads));
        args
    }

    /// 合成并返回 WAV 字节（临时文件方式，避免 stdout 二进制被污染）
    fn synthesize_to_file(&self, m: E2eTtsModel, text: &str) -> Result<(Vec<u8>, u32), AppError> {
        // 临时输出文件
        let out_dir = std::env::temp_dir();
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let out_path = out_dir.join(format!("voxflow_tts_{ts}.wav"));

        let mut cmd = Command::new(&self.tts_exe);
        for arg in self.cli_args(m) {
            cmd.arg(arg);
        }
        cmd.arg(format!("--output-filename={}", out_path.display()));
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

        // 读取 WAV 字节
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

    /// 设置语音克隆参数（ZipVoice / PocketTTS）
    /// `audio`: 参考音频文件路径；`text`: 参考音频对应的文字内容
    pub fn set_clone_voice(&mut self, audio: &Path, text: &str) -> TtsResult<()> {
        if !audio.exists() {
            return Err(AppError::LoadFailed(format!(
                "参考音频不存在: {}",
                audio.display()
            )));
        }
        if text.trim().is_empty() {
            return Err(AppError::InvalidInput("参考文本不能为空".into()));
        }
        self.reference_audio = Some(audio.to_path_buf());
        self.reference_text = Some(text.to_string());
        Ok(())
    }

    /// 清除语音克隆参数（回到预设音色模式）
    pub fn clear_clone_voice(&mut self) {
        self.reference_audio = None;
        self.reference_text = None;
    }

    /// 是否正在使用语音克隆
    pub fn is_cloning(&self) -> bool {
        self.reference_audio.is_some()
    }
}

/// 各模型必需文件（相对模型目录）
pub fn required_files(m: E2eTtsModel) -> Vec<&'static str> {
    match m {
        E2eTtsModel::KokoroV1_1 | E2eTtsModel::KokoroV1_0 | E2eTtsModel::KokoroEn => {
            vec!["model.onnx", "voices.bin", "tokens.txt", "lexicon-zh.txt", "lexicon-us-en.txt"]
        }
        // Matcha 官方 tarball 主模型名为 model-steps-3.onnx（下载后统一保留原名）
        E2eTtsModel::Matcha => vec!["tokens.txt"],
        E2eTtsModel::ZipVoice => vec![
            "encoder.int8.onnx",
            "decoder.int8.onnx",
            "lexicon.txt",
            "tokens.txt",
        ],
        E2eTtsModel::PocketTts => {
            vec!["lm_flow.int8.onnx", "lm_main.int8.onnx", "encoder.onnx", "decoder.onnx", "tokens.txt"]
        }
        E2eTtsModel::Supertonic => vec![
            "duration_predictor.int8.onnx",
            "text_encoder.int8.onnx",
            "vector_estimator.int8.onnx",
            "vocoder.int8.onnx",
            "tts.json",
            "unicode_indexer.bin",
            "voice.bin",
        ],
        E2eTtsModel::Kitten => vec!["model.onnx", "tokens.txt"],
    }
}

/// 解析主模型文件：优先标准名 model.onnx，回退 model-steps-*.onnx（Matcha 官方包）
fn main_model_file(dir: &Path) -> PathBuf {
    let standard = dir.join("model.onnx");
    if standard.exists() {
        return standard;
    }
    // 回退：model-steps-*.onnx
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut steps: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
                name.starts_with("model-steps-") && name.ends_with(".onnx")
            })
            .collect();
        if !steps.is_empty() {
            // 取最大的
            steps.sort_by_key(|p| p.metadata().map(|m| m.len()).unwrap_or(0));
            return steps.pop().unwrap();
        }
    }
    standard
}

impl TtsEngine for SherpaTtsEngine {
    fn name(&self) -> &str {
        self.model.map(|m| m.id()).unwrap_or("")
    }

    fn load(&mut self, model_path: &Path, _device: &str) -> TtsResult<()> {
        // 通过模型文件路径 / 目录名推断模型类型
        let m = detect_model(model_path).ok_or_else(|| {
            AppError::LoadFailed(format!("无法识别 E2E TTS 模型: {}", model_path.display()))
        })?;
        // 定位模型根目录（models/ 目录）
        let root = locate_models_root(model_path);
        if let Some(r) = root {
            self.model_root = r;
        }
        self.check_ready(m)?;
        // Supertonic 不支持中文（31 语言无 zh）：若当前语言是默认 zh，自动切换到 en
        if m == E2eTtsModel::Supertonic && self.language == "zh" {
            self.language = "en".to_string();
        }
        self.model = Some(m);
        Ok(())
    }

    fn unload(&mut self) -> TtsResult<()> {
        self.model = None;
        Ok(())
    }

    fn is_loaded(&self) -> bool {
        self.model.is_some()
    }

    fn set_language(&mut self, language: &str) -> TtsResult<()> {
        // 多语言模型校验语言是否受支持；单语言模型（Kitten/zh 模型）只允许对应语言
        if let Some(m) = self.model {
            let langs = m.languages();
            if !langs.iter().any(|&l| l == language) {
                return Err(AppError::InvalidInput(format!(
                    "模型 {} 不支持语言 '{language}'（支持: {}）",
                    m.id(),
                    langs.join(", ")
                )));
            }
        }
        self.language = language.to_string();
        Ok(())
    }

    fn infer(&mut self, text: &str, voice: &str) -> TtsResult<Vec<i16>> {
        let m = self.model.ok_or(AppError::NotInitialized)?;
        // voice 参数作为 sid（如 "45"），ZipVoice/PocketTTS 忽略 sid
        let saved_sid = self.sid;
        if let Ok(v) = voice.parse::<i32>() {
            self.sid = v;
        }
        let result = self.synthesize_to_file(m, text);
        self.sid = saved_sid;
        let (wav, sample_rate) = result?;

        // WAV → i16 PCM：定位 data chunk
        let mut off = 12;
        let mut data_start = 0usize;
        let mut data_len = 0usize;
        while off + 8 <= wav.len() {
            let id = &wav[off..off + 4];
            let sz =
                u32::from_le_bytes([wav[off + 4], wav[off + 5], wav[off + 6], wav[off + 7]]) as usize;
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

        // i16 little-endian
        let mut samples = Vec::with_capacity(data_len / 2);
        let mut i = data_start;
        while i + 1 < data_start + data_len {
            let v = i16::from_le_bytes([wav[i], wav[i + 1]]);
            samples.push(v);
            i += 2;
        }
        // 归一化到 24kHz（rust_synthesize 写文件用 24k）
        if sample_rate != 24000 && !samples.is_empty() {
            samples = resample_linear(&samples, sample_rate, 24000);
        }
        Ok(samples)
    }
}

/// 从模型文件路径 / 目录名推断模型类型
fn detect_model(model_path: &Path) -> Option<E2eTtsModel> {
    let lower = |p: &Path| p.to_string_lossy().to_lowercase();
    let file = model_path.file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let parent = model_path.parent().map(lower).unwrap_or_default();
    let haystack = format!("{file} {parent}");

    if haystack.contains("kokoro") {
        if haystack.contains("v1_1") {
            return Some(E2eTtsModel::KokoroV1_1);
        }
        if haystack.contains("v1_0") {
            return Some(E2eTtsModel::KokoroV1_0);
        }
        return Some(E2eTtsModel::KokoroEn);
    }
    if haystack.contains("matcha") {
        return Some(E2eTtsModel::Matcha);
    }
    if haystack.contains("zipvoice") {
        return Some(E2eTtsModel::ZipVoice);
    }
    if haystack.contains("pocket") {
        return Some(E2eTtsModel::PocketTts);
    }
    if haystack.contains("supertonic") {
        return Some(E2eTtsModel::Supertonic);
    }
    if haystack.contains("kitten") {
        return Some(E2eTtsModel::Kitten);
    }
    None
}

/// 向上定位 models/ 根目录（含 model.onnx 的目录的父目录）
fn locate_models_root(model_path: &Path) -> Option<PathBuf> {
    let mut d = model_path.parent();
    for _ in 0..4 {
        let dir = d?;
        if dir.join("sherpa-onnx-offline-tts.exe").exists() {
            return None;
        }
        // 若该目录下有一个子目录含 model.onnx，则认为它是 models/
        let has_model_subdir = dir
            .read_dir()
            .ok()?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .any(|e| e.path().join("model.onnx").exists() || e.path().join("encoder.onnx").exists());
        if has_model_subdir {
            return Some(dir.to_path_buf());
        }
        d = dir.parent();
    }
    None
}

/// 线性插值重采样（i16）
fn resample_linear(src: &[i16], from: u32, to: u32) -> Vec<i16> {
    if from == to || src.is_empty() {
        return src.to_vec();
    }
    let out_len = (src.len() as u64 * to as u64 / from as u64) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * from as f64 / to as f64;
        let idx = pos.floor() as usize;
        let frac = pos - idx as f64;
        let a = src[idx.min(src.len() - 1)] as f32;
        let b = src[(idx + 1).min(src.len() - 1)] as f32;
        out.push((a + (b - a) * frac as f32) as i16);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_model_kokoro_v1_1() {
        let p = Path::new("models/kokoro-multi-lang-v1_1/model.onnx");
        assert_eq!(detect_model(p), Some(E2eTtsModel::KokoroV1_1));
    }

    #[test]
    fn test_detect_model_kokoro_v1_0() {
        let p = Path::new("models/kokoro-multi-lang-v1_0/model.onnx");
        assert_eq!(detect_model(p), Some(E2eTtsModel::KokoroV1_0));
    }

    #[test]
    fn test_detect_model_matcha() {
        let p = Path::new("models/matcha-icefall-zh-baker/model.onnx");
        assert_eq!(detect_model(p), Some(E2eTtsModel::Matcha));
    }

    #[test]
    fn test_detect_model_zipvoice() {
        let p = Path::new("models/sherpa-onnx-zipvoice-distill/encoder.onnx");
        assert_eq!(detect_model(p), Some(E2eTtsModel::ZipVoice));
    }

    #[test]
    fn test_detect_model_pocket() {
        let p = Path::new("models/sherpa-onnx-pocket-tts-int8/lm_main.int8.onnx");
        assert_eq!(detect_model(p), Some(E2eTtsModel::PocketTts));
    }

    #[test]
    fn test_detect_model_supertonic() {
        let p = Path::new("models/sherpa-onnx-supertonic-3-tts-int8/encoder.onnx");
        assert_eq!(detect_model(p), Some(E2eTtsModel::Supertonic));
    }

    #[test]
    fn test_detect_model_kitten() {
        let p = Path::new("models/kitten-nano-en-v0_1-fp16/model.onnx");
        assert_eq!(detect_model(p), Some(E2eTtsModel::Kitten));
    }

    #[test]
    fn test_all_e2e_ids_unique() {
        let mut ids = E2eTtsModel::all().iter().map(|m| m.id()).collect::<Vec<_>>();
        let n = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), n, "模型 ID 必须唯一");
    }
}
