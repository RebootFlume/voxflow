//! sherpa-onnx E2E TTS 模型注册表
//!
//! 注册 6 个纯端到端模型（无音素 G2P 依赖），不含 VITS（音素模型）。
//! 每个模型定义：
//!   - id: 稳定标识符（用于切换与持久化）
//!   - display_name: 前端显示名
//!   - cli_prefix: sherpa-onnx CLI 参数前缀（--kokoro-*, --matcha-* 等）
//!   - model_dir_hint: 模型根目录名（用于路径解析）
//!   - languages: 支持语言列表（Kokoro 支持 zh/en 多语言，其他大部分为单语言）
//!   - is_chinese_optimized: 是否针对中文优化（用于默认推荐）

use std::path::Path;

/// speakers.json 条目（动态读取说话人列表）
#[derive(serde::Deserialize)]
pub struct SpeakerEntry {
    pub sid: i32,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum E2eTtsModel {
    KokoroV1_1,
    KokoroV1_0,
    KokoroEn,
    Matcha,
    ZipVoice,
    PocketTts,
    Supertonic,
    Kitten,
}

impl E2eTtsModel {
    /// 所有纯 E2E 模型列表（不含 VITS）
    pub fn all() -> Vec<E2eTtsModel> {
        vec![
            Self::KokoroV1_1,
            Self::KokoroV1_0,
            Self::KokoroEn,
            Self::Matcha,
            Self::ZipVoice,
            Self::PocketTts,
            Self::Supertonic,
            Self::Kitten,
        ]
    }

    /// 模型 ID（持久化用）
    pub fn id(&self) -> &'static str {
        match self {
            Self::KokoroV1_1 => "kokoro-v1_1",
            Self::KokoroV1_0 => "kokoro-v1_0",
            Self::KokoroEn => "kokoro-en",
            Self::Matcha => "matcha",
            Self::ZipVoice => "zipvoice",
            Self::PocketTts => "pocket-tts",
            Self::Supertonic => "supertonic",
            Self::Kitten => "kitten",
        }
    }

    /// 前端显示名
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::KokoroV1_1 => "Kokoro Multi-Lang v1.1 (zh/en, 103 speakers)",
            Self::KokoroV1_0 => "Kokoro Multi-Lang v1.0 (zh/en, 53 speakers)",
            Self::KokoroEn => "Kokoro English v0.19 (en, 11 speakers)",
            Self::Matcha => "Matcha (multilingual, high quality)",
            Self::ZipVoice => "ZipVoice (multilingual, voice cloning)",
            Self::PocketTts => "Pocket TTS (fast, low-latency)",
            Self::Supertonic => "Supertonic 3 (31 languages, high quality)",
            Self::Kitten => "Kitten TTS (lightweight, fast)",
        }
    }

    /// CLI 参数前缀（如 --kokoro-*）
    pub fn cli_prefix(&self) -> &'static str {
        match self {
            Self::KokoroV1_1 | Self::KokoroV1_0 | Self::KokoroEn => "kokoro",
            Self::Matcha => "matcha",
            Self::ZipVoice => "zipvoice",
            Self::PocketTts => "pocket",
            Self::Supertonic => "supertonic",
            Self::Kitten => "kitten",
        }
    }

    /// 默认模型根目录名（相对于 runtime root）
    pub fn default_model_dir(&self) -> &'static str {
        match self {
            Self::KokoroV1_1 => "kokoro-multi-lang-v1_1",
            Self::KokoroV1_0 => "kokoro-multi-lang-v1_0",
            Self::KokoroEn => "kokoro-en-v0_19",
            Self::Matcha => "matcha-icefall-zh-baker",
            Self::ZipVoice => "sherpa-onnx-zipvoice-distill",
            Self::PocketTts => "sherpa-onnx-pocket-tts-int8",
            Self::Supertonic => "sherpa-onnx-supertonic-3-tts-int8",
            Self::Kitten => "kitten-nano-en-v0_1-fp16",
        }
    }

    /// 是否针对中文优化（Kokoro v1_1/v1_0 优先推荐中文场景）
    pub fn is_chinese_optimized(&self) -> bool {
        matches!(self, Self::KokoroV1_1 | Self::KokoroV1_0)
    }

    /// 支持的语言列表（用于前端显示）
    pub fn languages(&self) -> Vec<&'static str> {
        match self {
            // Kokoro multi-lang：sherpa-onnx 仅导出/支持中英（文档明确说明）
            Self::KokoroV1_1 | Self::KokoroV1_0 => vec!["zh", "en"],
            Self::KokoroEn => vec!["en"],
            Self::Matcha => vec!["zh", "en"],
            Self::Supertonic => vec![
                // Supertonic 3 支持 31 语言
                "ar", "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de",
                "el", "hi", "hu", "id", "it", "ja", "ko", "lv", "lt", "pl", "pt",
                "ro", "ru", "sk", "sl", "es", "sv", "tr", "uk", "vi",
            ],
            Self::ZipVoice => vec!["zh", "en"],
            Self::PocketTts => vec!["zh", "en"],
            Self::Kitten => vec!["en"],
        }
    }

    /// 是否需要 sid（多说话人 ID）
    pub fn supports_speaker_id(&self) -> bool {
        // Kokoro 支持 sid；Supertonic 支持 sid + lang；其他根据文档判断
        matches!(
            self,
            Self::KokoroV1_1 | Self::KokoroV1_0 | Self::KokoroEn | Self::Supertonic
        )
    }

    /// 说话人数量（0 = 不支持 sid，如 ZipVoice/PocketTts）
    pub fn num_speakers(&self) -> usize {
        match self {
            Self::KokoroV1_1 => 103,
            Self::KokoroV1_0 => 53,
            Self::KokoroEn => 11,
            Self::Supertonic => 10,
            Self::Matcha => 1,
            Self::ZipVoice => 0,
            Self::PocketTts => 0,
            Self::Kitten => 1,
        }
    }

    /// 预设说话人列表：从模型目录的 speakers.json 动态读取
    /// speakers.json 格式: [{ "sid": 45, "name": "xiaobei" }, ...]
    /// 若文件不存在则生成通用编号列表
    pub fn speaker_list_from_dir(&self, model_root: &Path) -> Vec<(i32, String)> {
        let dir = model_root.join(self.default_model_dir());
        let json_path = dir.join("speakers.json");
        if json_path.exists() {
            if let Ok(data) = std::fs::read_to_string(&json_path) {
                if let Ok(list) = serde_json::from_str::<Vec<SpeakerEntry>>(&data) {
                    return list.into_iter().map(|e| (e.sid, e.name)).collect();
                }
            }
        }
        // 无 speakers.json 时，生成通用编号列表
        let n = self.num_speakers();
        (0..n).map(|i| (i as i32, format!("speaker {i}"))).collect()
    }

    /// 语言选择模式：
    ///   Auto    —— 模型自动识别（Kokoro 中英混合），无需用户选择
    ///   Fixed   —— 单语言模型，语言由模型固定（Kitten/English 等）
    ///   Select  —— 需要用户明确选择语言（Supertonic 31 语言）
    ///   Cloning —— 语音克隆模型，需参考音频而非语言选择（ZipVoice/Pocket）
    pub fn language_mode(&self) -> LanguageMode {
        match self {
            Self::KokoroV1_1 | Self::KokoroV1_0 => LanguageMode::Auto,
            Self::KokoroEn | Self::Kitten => LanguageMode::Fixed,
            Self::Supertonic => LanguageMode::Select,
            Self::Matcha => LanguageMode::Fixed, // 每个文件单语言
            Self::ZipVoice | Self::PocketTts => LanguageMode::Cloning,
        }
    }
}

/// 语言选择模式（决定前端是否显示语言/参考音频控件）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LanguageMode {
    /// 模型自动识别（如 Kokoro 中英混合），无需用户选择
    Auto,
    /// 单语言固定（如 Kokoro-en / Kitten / Matcha-zh）
    Fixed,
    /// 需用户选择语言（如 Supertonic 31 语言）
    Select,
    /// 语音克隆（ZipVoice / PocketTTS），需参考音频
    Cloning,
}

impl std::fmt::Display for E2eTtsModel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.display_name(), self.id())
    }
}

impl std::str::FromStr for E2eTtsModel {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        for m in Self::all() {
            if m.id() == s {
                return Ok(m);
            }
        }
        Err(format!("未知 E2E TTS 模型: {s}"))
    }
}

/// 获取所有纯 E2E TTS 模型的元数据（用于前端渲染和切换列表）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct E2eTtsModelInfo {
    pub id: String,
    pub name: String,
    pub cli_prefix: String,
    pub default_dir: String,
    pub is_chinese_optimized: bool,
    pub languages: Vec<String>,
    pub supports_speaker: bool,
    pub language_mode: LanguageMode,
}

impl From<E2eTtsModel> for E2eTtsModelInfo {
    fn from(m: E2eTtsModel) -> Self {
        Self {
            id: m.id().to_string(),
            name: m.display_name().to_string(),
            cli_prefix: m.cli_prefix().to_string(),
            default_dir: m.default_model_dir().to_string(),
            is_chinese_optimized: m.is_chinese_optimized(),
            languages: m.languages().into_iter().map(String::from).collect(),
            supports_speaker: m.supports_speaker_id(),
            language_mode: m.language_mode(),
        }
    }
}

/// 生成前端可用的模型列表（JSON 序列化格式）
pub fn generate_model_catalog_json() -> String {
    let models: Vec<E2eTtsModelInfo> = E2eTtsModel::all().into_iter().map(Into::into).collect();
    serde_json::to_string_pretty(&models).unwrap()
}
