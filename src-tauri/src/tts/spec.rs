//! 模型描述符（ModelSpec）：框架与模型解耦的契约
//!
//! 合并自三处旧数据源（P1 阶段三者并存，本表为新的单一真源，一致性由测试对齐）：
//! - `model_manager.rs` REGISTRY（下载 / 展示：name/repo/size/engine_dir/quant）
//! - `tts/engine/e2e_registry.rs`（能力：languages/language_mode/voice_mode；P3 已合并删除）
//! - `tts/engine/sherpa.rs` 的 cli_args / required_files（引擎参数：ArgSpec）
//!
//! 原则（契约，见方案文档 3.2 / 4.2 / 7.6）：
//! - 加模型 = 加一条数据；引擎只读本表，禁止模型名分支。
//! - 描述符查找接受 展示名 / id / 目录名 归一化匹配（find_by_name）。
//! - 同一表内不允许两个条目归一化后相同（schema 校验测试保证）。


/// 模型种类
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelKind {
    Asr,
    Tts,
}

impl ModelKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Asr => "asr",
            Self::Tts => "tts",
        }
    }
}

/// 语言选择模式（决定前端是否显示语言 / 参考音频控件）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LanguageMode {
    /// 模型自动识别（Kokoro 中英混合），无需用户选择
    Auto,
    /// 单语言固定（Kokoro-en / Kitten / Matcha-zh）
    Fixed,
    /// 需用户选择语言（Supertonic 31 语言）
    Select,
    /// 语音克隆（ZipVoice），需参考音频
    Cloning,
}

/// 预设音色（sid 制）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresetSpec {
    /// 兜底数量（无 speakers_file 时生成 0..count）
    pub count: u16,
    /// speakers.json（有则读名字，数量 = 列表长度）
    pub speakers_file: Option<&'static str>,
    /// sid 是否按语言独立（Supertonic 是；Kokoro 否，全局 sid）
    pub per_language: bool,
}

/// 语音克隆能力声明
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CloneSpec {
    /// 是否必须配参考文本（ZipVoice 是）
    pub requires_text: bool,
    /// 克隆激活时是否忽略 sid（当前克隆模型都是）
    pub overrides_preset: bool,
}

/// 音色机制（驱动 UI 与引擎，替代前端正则嗅探）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceMode {
    /// 无音色选择（单音色）——Matcha / Kitten
    Fixed,
    /// 预设音色（sid 制）——Kokoro 系 / Supertonic
    Preset(PresetSpec),
    /// 语音克隆（参考音频 ± 参考文本）——ZipVoice
    Clone(CloneSpec),
    /// 预设 + 克隆并存——当前无此模型，schema 预留，未来模型无需扩协议
    PresetAndClone(PresetSpec, CloneSpec),
}

/// CLI 参数运行时占位键（解释器在合成时按运行时状态填充）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeKey {
    /// 说话人 id（--sid）
    SpeakerId,
    /// 语言（--lang，Supertonic）
    Language,
    /// 推理提供者（--provider）
    Provider,
    /// 推理线程数（--num-threads）
    NumThreads,
    /// 输出文件路径（--output-filename）
    OutputPath,
    /// 语音克隆参考音频（--reference-audio）
    ReferenceAudio,
    /// 语音克隆参考文本（--reference-text）
    ReferenceText,
    /// 主模型文件（model.onnx 优先，回退 model-steps-*.onnx 取最大）
    MainModelFile,
}

/// CLI 参数说明符（类型化契约，见方案文档 7.6）
/// 路径类参数默认相对「模型目录」；`ModelsRootFile` 相对「models 根目录」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArgSpec {
    /// 恒定参数：flag → 值
    Static(&'static str, &'static str),
    /// 必填文件：flag → 相对模型目录文件（缺失报错）
    File(&'static str, &'static str),
    /// 可选单文件：文件存在才加
    OptionalFile(&'static str, &'static str),
    /// 可选多候选文件：按声明顺序 join（存在才加入）成一个 flag（--kokoro-lexicon=a,b,c）
    JoinableFiles(&'static str, &'static [&'static str], char),
    /// 必填文件（相对 models 根目录，如 ZipVoice 的 vocos_24khz.onnx）
    ModelsRootFile(&'static str, &'static str),
    /// 运行时占位：flag → 引擎按 RuntimeKey 填充
    RuntimeVar(&'static str, RuntimeKey),
}

/// TTS 后端（sherpa-onnx 子进程）引擎参数
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SherpaTtsSpec {
    /// 模型专用 CLI 参数（解释器另加通用参数：--provider/--num-threads/--output-filename/text）
    pub cli: &'static [ArgSpec],
    /// 必需文件（相对模型目录；check_ready 用）
    pub required_files: &'static [&'static str],
}

/// ASR 后端（llama-server / sherpa websocket server）引擎参数
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AsrBackendSpec {
    /// llama-server（GGUF）：文件由该模型的精选条目声明（`DownloadEntry.files`），此处无数据
    Llama,
    /// sherpa-onnx websocket server：主模型 flag
    SherpaWs {
        /// "--sense-voice-model" 或 "--paraformer"
        flag: &'static str,
    },
}

/// 引擎参数（按 kind 解释）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendSpec {
    Llama(AsrBackendSpec),
    SherpaWs(AsrBackendSpec),
    SherpaTts(SherpaTtsSpec),
}

/// 条目内文件的角色（加载端据此取值，不再"猜哪个文件是主模型"）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileRole {
    /// 主权重 / 主模型文件
    Main,
    /// 多模态投影（GGUF 的音频编码器 mmproj）
    Mmproj,
}

/// 条目里的一个文件（相对仓库根 / 模型目录的文件名，可含子目录）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EntryFile {
    pub role: FileRole,
    pub name: &'static str,
    /// 该文件的体积（MB）。已实测的写实测值；未实测的按同族估算（注释标明）
    pub size_mb: u64,
}

/// 精选下载条目：一组"我们调试后定死"的文件组合。
///
/// 用户看到的是一行标签，点下载即安装这一组文件；代码里不再做任何文件名推导。
/// 加新组合 = 加一条数据；同一模型只允许同时安装一条（切换 = 换文件集）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DownloadEntry {
    /// 稳定键（manifest / IPC 用）
    pub id: &'static str,
    pub label_zh: &'static str,
    pub label_en: &'static str,
    /// 要下载的文件（顺序 = 下载顺序）
    pub files: &'static [EntryFile],
    pub default: bool,
}

impl DownloadEntry {
    /// 按角色取文件名（该角色未声明 → None）
    pub fn file(&self, role: FileRole) -> Option<&'static str> {
        self.files.iter().find(|f| f.role == role).map(|f| f.name)
    }

    /// 条目体积（GB）——由声明文件体积求和（单一真源，不再单独维护）
    pub fn size_gb(&self) -> f64 {
        self.files.iter().map(|f| f.size_mb).sum::<u64>() as f64 / 1024.0
    }
}

/// 模型下载来源
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadSource {
    /// GitHub release 直链（当前 10 个模型；只受代理影响）
    GithubRelease(&'static str),
    /// HuggingFace 仓库（按 `entries` 里的文件名逐个直链下载；受代理 / token 影响）
    HuggingFace {
        repo: &'static str,
        /// "main" 或 commit hash（钉住版本保证可复现）
        revision: &'static str,
    },
}

/// 主包之外的附加文件（如 ZipVoice 的 vocoder）：来源 + 落盘相对路径
/// （相对**模型根**，与 `ArgSpec::ModelsRootFile` 解析同一处；一致性由测试保证）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExtraFile {
    pub source: DownloadSource,
    pub dest_rel: &'static str,
}

/// 模型描述符：一条 = 一个模型的全部信息（下载 / 能力 / 引擎参数）
#[derive(Debug, Clone, PartialEq)]
pub struct ModelSpec {
    /// 引擎目录名（唯一 key；与 model_manager engine_dir 一致）
    pub id: &'static str,
    /// 展示名（前端显示 / 查找别名）
    pub name: &'static str,
    pub kind: ModelKind,
    /// 引擎注册键（与 `model_manager::FRAMEWORKS.id` 对应）："gguf" | "onnx" | "sherpa"。
    /// 引擎路由 / 运行时包 / 文件发现全部由它查表 —— 新增框架不再需要改 match。
    pub framework: &'static str,
    /// 下载来源（唯一来源声明；UI 展示标签由它推导，见 model_manager::source_label）
    pub source: DownloadSource,
    /// 精选下载条目（空 = 无条目概念：按 old 路径整体下载，如 GitHub tarball 模型）
    pub entries: &'static [DownloadEntry],
    pub size_gb: f64,
    pub description_zh: &'static str,
    pub description_en: &'static str,
    pub available: bool,
    /// CPU 模式体验分级："good" / "slow" / "unsupported"
    pub cpu: &'static str,
    /// 主包之外的附加文件（默认空）
    pub extra_files: &'static [ExtraFile],
    /// 量化版本（GGUF: Q8_0 / bf16；ONNX: 无）
    pub quant: Option<&'static str>,
    // ── TTS 能力（仅 kind=Tts 有意义；ASR 置空）──
    pub languages: &'static [&'static str],
    pub language_mode: LanguageMode,
    pub voice_mode: VoiceMode,
    // ── 引擎参数 ──
    pub backend: BackendSpec,
}

/// 归一化：大小写不敏感 + 去掉 - 和 _（"Kokoro-v1_0" → "kokorov10"）
fn norm(s: &str) -> String {
    s.to_lowercase().replace(['-', '_'], "")
}

impl ModelSpec {
    /// 全部 TTS 模型（描述符驱动；前端列表 / 能力数据源）
    pub fn all_tts() -> Vec<&'static ModelSpec> {
        SPECS.iter().filter(|m| m.kind == ModelKind::Tts).collect()
    }

    /// 按 id 取精选条目（未知 → None）
    pub fn entry(&self, id: &str) -> Option<&'static DownloadEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// 默认条目（无条目 → None；未标 default 时取第一条）
    pub fn default_entry(&self) -> Option<&'static DownloadEntry> {
        self.entries
            .iter()
            .find(|e| e.default)
            .or_else(|| self.entries.first())
    }

    /// 按别名查找：精确 id > 归一化 id > 归一化目录名（id）> 归一化展示名。
    /// 接受前端展示名（Kokoro-v1_0）、引擎 id（kokoro-v1_0）、引擎目录名（kokoro-multi-lang-v1_0）。
    pub fn find(input: &str) -> Option<&'static ModelSpec> {
        // 1. 精确 id / 展示名
        for m in SPECS {
            if m.id == input || m.name == input {
                return Some(m);
            }
        }
        let input_norm = norm(input);
        // 2. 归一化 id / 展示名
        for m in SPECS {
            if norm(m.id) == input_norm || norm(m.name) == input_norm {
                return Some(m);
            }
        }
        // 3. 族前缀兜底（最低优先级；唯一性由测试保证）
        let prefix = input
            .split(|c: char| !c.is_alphanumeric())
            .next()
            .unwrap_or("")
            .to_lowercase();
        if !prefix.is_empty() {
            for m in SPECS {
                if norm(m.id).starts_with(&prefix) {
                    return Some(m);
                }
            }
        }
        None
    }
}

/// 全部模型描述符（ASR + TTS 一张表）
///
/// 数据忠实捕获旧三源（P1 行为不变）；一致性由 `tests::spec_matches_legacy_sources`
/// 系列测试对齐。待核对项标注在注释中（决策 6：PocketTTS 克隆能力）。
pub static SPECS: &[ModelSpec] = &[
    // ══════════════ ASR：llama-server（GGUF）══════════════
    ModelSpec {
        id: "qwen3-asr-0.6b-gguf",
        name: "Qwen3-ASR-0.6B",
        kind: ModelKind::Asr,
        framework: "gguf",
        source: DownloadSource::HuggingFace {
            repo: "ggml-org/Qwen3-ASR-0.6B-GGUF",
            revision: "main",
        },
        // 精选条目：文件组合由我们调试后定死，用户只选一条；同一模型同时只装一条。
        // 默认 = 主权重 Q8_0 + 解码器 bf16（调试结论：解码器取无损 bf16，质量优先）
        // ⚠️ size_mb = **磁盘实测字节数 / 1024²**（不是估算）：它同时驱动下载进度、磁盘预检
        //    （并集 ×2）与 UI 显示，写错会直接体现在界面上。新增条目请按实际文件填。
        entries: &[
            DownloadEntry {
                id: "q8_0__mp_bf16",
                label_zh: "Q8_0 主权重 + bf16 解码器 · 推荐",
                label_en: "Q8_0 weights + bf16 decoder · Recommended",
                files: &[
                    EntryFile { role: FileRole::Main, name: "Qwen3-ASR-0.6B-Q8_0.gguf", size_mb: 768 },
                    EntryFile { role: FileRole::Mmproj, name: "mmproj-Qwen3-ASR-0.6B-bf16.gguf", size_mb: 361 },
                ],
                default: true,
            },
            DownloadEntry {
                id: "q8_0__mp_q8",
                label_zh: "Q8_0 主权重 + Q8_0 解码器（更省显存）",
                label_en: "Q8_0 weights + Q8_0 decoder (lower VRAM)",
                files: &[
                    EntryFile { role: FileRole::Main, name: "Qwen3-ASR-0.6B-Q8_0.gguf", size_mb: 768 },
                    EntryFile { role: FileRole::Mmproj, name: "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf", size_mb: 205 },
                ],
                default: false,
            },
        ],
        size_gb: 1.10, // 默认条目实测：768 + 361 MiB
        description_zh: "默认识别模型 · GGUF 量化 · 更快 · 内存占用更低",
        description_en: "Default ASR model · GGUF quantized · faster · lower memory",
        available: true,
        cpu: "good",
        extra_files: &[],
        quant: Some("Q8_0"),
        languages: &[],
        language_mode: LanguageMode::Fixed,
        voice_mode: VoiceMode::Fixed,
        backend: BackendSpec::Llama(AsrBackendSpec::Llama),
    },
    ModelSpec {
        id: "Qwen3-ASR-1.7B",
        name: "Qwen3-ASR-1.7B",
        kind: ModelKind::Asr,
        framework: "gguf",
        source: DownloadSource::HuggingFace {
            repo: "ggml-org/Qwen3-ASR-1.7B-GGUF",
            revision: "main",
        },
        // 精选条目同上（默认 = 主 Q8_0 + 解码器 bf16）
        entries: &[
            DownloadEntry {
                id: "q8_0__mp_bf16",
                label_zh: "Q8_0 主权重 + bf16 解码器 · 推荐",
                label_en: "Q8_0 weights + bf16 decoder · Recommended",
                files: &[
                    EntryFile { role: FileRole::Main, name: "Qwen3-ASR-1.7B-Q8_0.gguf", size_mb: 2065 },
                    EntryFile { role: FileRole::Mmproj, name: "mmproj-Qwen3-ASR-1.7B-bf16.gguf", size_mb: 612 },
                ],
                default: true,
            },
            DownloadEntry {
                id: "q8_0__mp_q8",
                label_zh: "Q8_0 主权重 + Q8_0 解码器（更省显存）",
                label_en: "Q8_0 weights + Q8_0 decoder (lower VRAM)",
                files: &[
                    EntryFile { role: FileRole::Main, name: "Qwen3-ASR-1.7B-Q8_0.gguf", size_mb: 2065 },
                    EntryFile { role: FileRole::Mmproj, name: "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf", size_mb: 339 },
                ],
                default: false,
            },
        ],
        size_gb: 2.61, // 默认条目实测：2065 + 612 MiB
        description_zh: "更准 · GGUF 量化 · 需要更多内存/显存",
        description_en: "More accurate · GGUF quantized · needs more memory",
        available: true,
        cpu: "slow",
        extra_files: &[],
        quant: Some("Q8_0"),
        languages: &[],
        language_mode: LanguageMode::Fixed,
        voice_mode: VoiceMode::Fixed,
        backend: BackendSpec::Llama(AsrBackendSpec::Llama),
    },
    // ══════════════ ASR：sherpa-onnx websocket server ══════════════
    ModelSpec {
        id: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
        name: "SenseVoice-int8",
        kind: ModelKind::Asr,
        framework: "onnx",
        size_gb: 0.23,
        description_zh: "中文全能 · 中英日韩粤 5 语 · 情感/事件/时间戳",
        description_en: "All-round Chinese · zh/en/ja/ko/yue · emotion/event/timestamps",
        available: true,
        cpu: "good",
        source: DownloadSource::GithubRelease("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2"),
        entries: &[],
        extra_files: &[],
        quant: None,
        languages: &[],
        language_mode: LanguageMode::Fixed,
        voice_mode: VoiceMode::Fixed,
        backend: BackendSpec::SherpaWs(AsrBackendSpec::SherpaWs {
            flag: "--sense-voice-model",
        }),
    },
    ModelSpec {
        id: "sherpa-onnx-paraformer-zh-small-2024-03-09",
        name: "Paraformer-zh-small",
        kind: ModelKind::Asr,
        framework: "onnx",
        size_gb: 0.1,
        description_zh: "中文超小 · 74MB · 低端 CPU 设备首选",
        description_en: "Tiny Chinese · 74MB · best for low-end CPU",
        available: true,
        cpu: "good",
        source: DownloadSource::GithubRelease("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2"),
        entries: &[],
        extra_files: &[],
        quant: None,
        languages: &[],
        language_mode: LanguageMode::Fixed,
        voice_mode: VoiceMode::Fixed,
        backend: BackendSpec::SherpaWs(AsrBackendSpec::SherpaWs {
            flag: "--paraformer",
        }),
    },
    // ══════════════ TTS：sherpa-onnx 纯端到端 ══════════════
    ModelSpec {
        id: "kokoro-multi-lang-v1_1",
        name: "Kokoro-v1_1",
        kind: ModelKind::Tts,
        framework: "sherpa",
        size_gb: 0.32,
        description_zh: "Kokoro 多语言 v1.1 · 中英103音色 · 纯端到端 · sherpa-onnx 推荐",
        description_en: "Kokoro multi-lang v1.1 · zh/en 103 voices · E2E · sherpa-onnx recommended",
        available: true,
        cpu: "good",
        source: DownloadSource::GithubRelease("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2"),
        entries: &[],
        extra_files: &[],
        quant: None,
        languages: &["zh", "en"],
        language_mode: LanguageMode::Auto,
        voice_mode: VoiceMode::Preset(PresetSpec {
            count: 103,
            speakers_file: Some("speakers.json"),
            per_language: false,
        }),
        backend: BackendSpec::SherpaTts(SherpaTtsSpec {
            cli: &[
                ArgSpec::File("--kokoro-model", "model.onnx"),
                ArgSpec::File("--kokoro-voices", "voices.bin"),
                ArgSpec::File("--kokoro-tokens", "tokens.txt"),
                ArgSpec::File("--kokoro-data-dir", "espeak-ng-data"),
                ArgSpec::JoinableFiles(
                    "--kokoro-lexicon",
                    &["lexicon-us-en.txt", "lexicon-gb-en.txt", "lexicon-zh.txt"],
                    ',',
                ),
                ArgSpec::JoinableFiles(
                    "--tts-rule-fsts",
                    &["date-zh.fst", "phone-zh.fst", "number-zh.fst"],
                    ',',
                ),
                ArgSpec::RuntimeVar("--sid", RuntimeKey::SpeakerId),
                ArgSpec::RuntimeVar("--provider", RuntimeKey::Provider),
                ArgSpec::RuntimeVar("--num-threads", RuntimeKey::NumThreads),
            ],
            required_files: &[
                "model.onnx",
                "voices.bin",
                "tokens.txt",
                "lexicon-zh.txt",
                "lexicon-us-en.txt",
            ],
        }),
    },
    ModelSpec {
        id: "kokoro-multi-lang-v1_0",
        name: "Kokoro-v1_0",
        kind: ModelKind::Tts,
        framework: "sherpa",
        size_gb: 0.32,
        description_zh: "Kokoro 多语言 v1.0 · 中英53音色 · 纯端到端",
        description_en: "Kokoro multi-lang v1.0 · zh/en 53 voices · E2E",
        available: true,
        cpu: "good",
        source: DownloadSource::GithubRelease("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2"),
        entries: &[],
        extra_files: &[],
        quant: None,
        languages: &["zh", "en"],
        language_mode: LanguageMode::Auto,
        voice_mode: VoiceMode::Preset(PresetSpec {
            count: 53,
            speakers_file: Some("speakers.json"),
            per_language: false,
        }),
        backend: BackendSpec::SherpaTts(SherpaTtsSpec {
            cli: &[
                ArgSpec::File("--kokoro-model", "model.onnx"),
                ArgSpec::File("--kokoro-voices", "voices.bin"),
                ArgSpec::File("--kokoro-tokens", "tokens.txt"),
                ArgSpec::File("--kokoro-data-dir", "espeak-ng-data"),
                ArgSpec::JoinableFiles(
                    "--kokoro-lexicon",
                    &["lexicon-us-en.txt", "lexicon-gb-en.txt", "lexicon-zh.txt"],
                    ',',
                ),
                ArgSpec::JoinableFiles(
                    "--tts-rule-fsts",
                    &["date-zh.fst", "phone-zh.fst", "number-zh.fst"],
                    ',',
                ),
                ArgSpec::RuntimeVar("--sid", RuntimeKey::SpeakerId),
                ArgSpec::RuntimeVar("--provider", RuntimeKey::Provider),
                ArgSpec::RuntimeVar("--num-threads", RuntimeKey::NumThreads),
            ],
            required_files: &[
                "model.onnx",
                "voices.bin",
                "tokens.txt",
                "lexicon-zh.txt",
                "lexicon-us-en.txt",
            ],
        }),
    },
    ModelSpec {
        id: "kokoro-en-v0_19",
        name: "Kokoro-en-v0_19",
        kind: ModelKind::Tts,
        framework: "sherpa",
        size_gb: 0.32,
        description_zh: "Kokoro 英文 v0.19 · 11音色 · 纯端到端",
        description_en: "Kokoro English v0.19 · 11 voices · E2E",
        available: true,
        cpu: "good",
        source: DownloadSource::GithubRelease("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2"),
        entries: &[],
        extra_files: &[],
        quant: None,
        languages: &["en"],
        language_mode: LanguageMode::Fixed,
        voice_mode: VoiceMode::Preset(PresetSpec {
            count: 11,
            speakers_file: Some("speakers.json"),
            per_language: false,
        }),
        backend: BackendSpec::SherpaTts(SherpaTtsSpec {
            cli: &[
                ArgSpec::File("--kokoro-model", "model.onnx"),
                ArgSpec::File("--kokoro-voices", "voices.bin"),
                ArgSpec::File("--kokoro-tokens", "tokens.txt"),
                ArgSpec::File("--kokoro-data-dir", "espeak-ng-data"),
                ArgSpec::JoinableFiles(
                    "--kokoro-lexicon",
                    &["lexicon-us-en.txt", "lexicon-gb-en.txt", "lexicon-zh.txt"],
                    ',',
                ),
                ArgSpec::JoinableFiles(
                    "--tts-rule-fsts",
                    &["date-zh.fst", "phone-zh.fst", "number-zh.fst"],
                    ',',
                ),
                ArgSpec::RuntimeVar("--sid", RuntimeKey::SpeakerId),
                ArgSpec::RuntimeVar("--provider", RuntimeKey::Provider),
                ArgSpec::RuntimeVar("--num-threads", RuntimeKey::NumThreads),
            ],
            // 注意：英文包可能不含 lexicon-zh.txt（required 校验时核对官方包）
            required_files: &[
                "model.onnx",
                "voices.bin",
                "tokens.txt",
                "lexicon-zh.txt",
                "lexicon-us-en.txt",
            ],
        }),
    },
    ModelSpec {
        id: "matcha-icefall-zh-baker",
        name: "Matcha-zh-baker",
        kind: ModelKind::Tts,
        framework: "sherpa",
        size_gb: 0.3,
        description_zh: "Matcha 中文 · 高质量 · 纯端到端",
        description_en: "Matcha Chinese · high quality · E2E",
        available: true,
        cpu: "good",
        source: DownloadSource::GithubRelease("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/matcha-icefall-zh-baker.tar.bz2"),
        entries: &[],
        // vocoder 与模型分开下载（与 ZipVoice 同一处理）；必须落**模型根** —— 与下面
        // `ModelsRootFile("--matcha-vocoder", …)` 的解析位置同处，也避免被 MainModelFile 误选。
        extra_files: &[ExtraFile {
            source: DownloadSource::GithubRelease(
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos-22khz-univ.onnx",
            ),
            dest_rel: "vocos-22khz-univ.onnx",
        }],
        quant: None,
        // zh-baker 实为中文单语言（旧注册表 languages 含 en，P2 核对官方包后定）
        languages: &["zh", "en"],
        language_mode: LanguageMode::Fixed,
        voice_mode: VoiceMode::Fixed,
        backend: BackendSpec::SherpaTts(SherpaTtsSpec {
            cli: &[
                ArgSpec::RuntimeVar("--matcha-acoustic-model", RuntimeKey::MainModelFile),
                ArgSpec::ModelsRootFile("--matcha-vocoder", "vocos-22khz-univ.onnx"),
                ArgSpec::File("--matcha-tokens", "tokens.txt"),
                // 中文 Matcha 走 lexicon。**绝不能**再传 `--matcha-data-dir`：
                // sherpa-onnx 里它一旦给出就会忽略 `--matcha-lexicon`
                //（见 `sherpa-onnx-offline-tts --help`），而本模型目录没有 espeak-ng-data
                // ⇒ CLI 直接报 "Errors in config!"（用户实际撞到的就是这条）。
                ArgSpec::File("--matcha-lexicon", "lexicon.txt"),
                // 中文文本正则（数字/日期/电话）：通用 flag 是 `--tts-rule-fsts`，非 matcha 前缀
                ArgSpec::JoinableFiles(
                    "--tts-rule-fsts",
                    &["date.fst", "number.fst", "phone.fst"],
                    ',',
                ),
                ArgSpec::RuntimeVar("--sid", RuntimeKey::SpeakerId),
                ArgSpec::RuntimeVar("--provider", RuntimeKey::Provider),
                ArgSpec::RuntimeVar("--num-threads", RuntimeKey::NumThreads),
            ],
            required_files: &["model-steps-3.onnx", "tokens.txt", "lexicon.txt"],
        }),
    },
    ModelSpec {
        id: "sherpa-onnx-zipvoice-distill",
        name: "ZipVoice-distill",
        kind: ModelKind::Tts,
        framework: "sherpa",
        size_gb: 0.4,
        description_zh: "ZipVoice 蒸馏 · 中英 · 语音克隆 · 纯端到端",
        description_en: "ZipVoice distill · zh/en · voice clone · E2E",
        available: true,
        cpu: "good",
        source: DownloadSource::GithubRelease("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2"),
        entries: &[],
        // vocoder 必须落模型根 —— 与 backend 的 ModelsRootFile("--zipvoice-vocoder", "vocos_24khz.onnx") 同处
        extra_files: &[ExtraFile {
            source: DownloadSource::GithubRelease("https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos_24khz.onnx"),
            dest_rel: "vocos_24khz.onnx",
        }],
        quant: None,
        languages: &["zh", "en"],
        language_mode: LanguageMode::Cloning,
        voice_mode: VoiceMode::Clone(CloneSpec {
            requires_text: true,
            overrides_preset: true,
        }),
        backend: BackendSpec::SherpaTts(SherpaTtsSpec {
            cli: &[
                ArgSpec::File("--zipvoice-encoder", "encoder.int8.onnx"),
                ArgSpec::File("--zipvoice-decoder", "decoder.int8.onnx"),
                ArgSpec::File("--zipvoice-lexicon", "lexicon.txt"),
                ArgSpec::File("--zipvoice-tokens", "tokens.txt"),
                ArgSpec::File("--zipvoice-data-dir", "espeak-ng-data"),
                ArgSpec::ModelsRootFile("--zipvoice-vocoder", "vocos_24khz.onnx"),
                ArgSpec::RuntimeVar("--reference-audio", RuntimeKey::ReferenceAudio),
                ArgSpec::RuntimeVar("--reference-text", RuntimeKey::ReferenceText),
                ArgSpec::RuntimeVar("--provider", RuntimeKey::Provider),
                ArgSpec::RuntimeVar("--num-threads", RuntimeKey::NumThreads),
            ],
            required_files: &[
                "encoder.int8.onnx",
                "decoder.int8.onnx",
                "lexicon.txt",
                "tokens.txt",
            ],
        }),
    },
    ModelSpec {
        id: "sherpa-onnx-pocket-tts-int8",
        name: "PocketTTS-int8",
        kind: ModelKind::Tts,
        framework: "sherpa",
        size_gb: 0.5,
        description_zh: "Pocket TTS int8 · 快速低延迟 · 纯端到端（克隆未接线）",
        description_en: "Pocket TTS int8 · fast · E2E (clone not wired)",
        available: true,
        cpu: "good",
        source: DownloadSource::GithubRelease("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2"),
        entries: &[],
        extra_files: &[],
        quant: None,
        // 决策 6：克隆能力待核对官方文档；当前 CLI 未接线参考音频（no-op bug），按无克隆处理
        languages: &["zh", "en"],
        language_mode: LanguageMode::Fixed,
        voice_mode: VoiceMode::Fixed,
        backend: BackendSpec::SherpaTts(SherpaTtsSpec {
            cli: &[
                ArgSpec::File("--pocket-lm-flow", "lm_flow.int8.onnx"),
                ArgSpec::File("--pocket-lm-main", "lm_main.int8.onnx"),
                ArgSpec::File("--pocket-encoder", "encoder.onnx"),
                ArgSpec::File("--pocket-decoder", "decoder.onnx"),
                ArgSpec::File("--pocket-tokens", "tokens.txt"),
                ArgSpec::File("--pocket-data-dir", "espeak-ng-data"),
                ArgSpec::RuntimeVar("--provider", RuntimeKey::Provider),
                ArgSpec::RuntimeVar("--num-threads", RuntimeKey::NumThreads),
            ],
            required_files: &[
                "lm_flow.int8.onnx",
                "lm_main.int8.onnx",
                "encoder.onnx",
                "decoder.onnx",
                "tokens.txt",
            ],
        }),
    },
    ModelSpec {
        id: "sherpa-onnx-supertonic-3-tts-int8",
        name: "Supertonic-3-int8",
        kind: ModelKind::Tts,
        framework: "sherpa",
        size_gb: 0.6,
        description_zh: "Supertonic 3 · 31语言 · 高质量 · 纯端到端",
        description_en: "Supertonic 3 · 31 languages · high quality · E2E",
        available: true,
        cpu: "good",
        source: DownloadSource::GithubRelease("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2"),
        entries: &[],
        extra_files: &[],
        quant: None,
        languages: &[
            "ar", "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hi", "hu",
            "id", "it", "ja", "ko", "lv", "lt", "pl", "pt", "ro", "ru", "sk", "sl", "es", "sv",
            "tr", "uk", "vi",
        ],
        language_mode: LanguageMode::Select,
        voice_mode: VoiceMode::Preset(PresetSpec {
            count: 10,
            speakers_file: None,
            per_language: true,
        }),
        backend: BackendSpec::SherpaTts(SherpaTtsSpec {
            cli: &[
                ArgSpec::File("--supertonic-duration-predictor", "duration_predictor.int8.onnx"),
                ArgSpec::File("--supertonic-text-encoder", "text_encoder.int8.onnx"),
                ArgSpec::File("--supertonic-vector-estimator", "vector_estimator.int8.onnx"),
                ArgSpec::File("--supertonic-vocoder", "vocoder.int8.onnx"),
                ArgSpec::File("--supertonic-tts-json", "tts.json"),
                ArgSpec::File("--supertonic-unicode-indexer", "unicode_indexer.bin"),
                ArgSpec::File("--supertonic-voice-style", "voice.bin"),
                ArgSpec::RuntimeVar("--sid", RuntimeKey::SpeakerId),
                ArgSpec::RuntimeVar("--lang", RuntimeKey::Language),
                ArgSpec::RuntimeVar("--provider", RuntimeKey::Provider),
                ArgSpec::RuntimeVar("--num-threads", RuntimeKey::NumThreads),
            ],
            required_files: &[
                "duration_predictor.int8.onnx",
                "text_encoder.int8.onnx",
                "vector_estimator.int8.onnx",
                "vocoder.int8.onnx",
                "tts.json",
                "unicode_indexer.bin",
                "voice.bin",
            ],
        }),
    },
    ModelSpec {
        id: "kitten-nano-en-v0_1-fp16",
        name: "Kitten-nano-en",
        kind: ModelKind::Tts,
        framework: "sherpa",
        size_gb: 0.2,
        description_zh: "Kitten nano · 轻量快速 · 英文 · 纯端到端",
        description_en: "Kitten nano · lightweight · en · E2E",
        available: true,
        cpu: "good",
        source: DownloadSource::GithubRelease("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_1-fp16.tar.bz2"),
        entries: &[],
        extra_files: &[],
        quant: None,
        languages: &["en"],
        language_mode: LanguageMode::Fixed,
        voice_mode: VoiceMode::Fixed,
        backend: BackendSpec::SherpaTts(SherpaTtsSpec {
            cli: &[
                ArgSpec::File("--kitten-model", "model.onnx"),
                ArgSpec::File("--kitten-tokens", "tokens.txt"),
                ArgSpec::RuntimeVar("--sid", RuntimeKey::SpeakerId),
                ArgSpec::RuntimeVar("--provider", RuntimeKey::Provider),
                ArgSpec::RuntimeVar("--num-threads", RuntimeKey::NumThreads),
            ],
            required_files: &["model.onnx", "tokens.txt"],
        }),
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    /// 来源声明合法性：GH 直链必须指向 release 资产；HF 源必须是 owner/repo 形式。
    /// 防手改出非法状态（如把 HF 直链塞进 HuggingFace、或把仓库名塞进 github_release）。
    #[test]
    fn test_download_sources_wellformed() {
        for m in SPECS {
            match m.source {
                DownloadSource::GithubRelease(u) => {
                    assert!(u.starts_with("https://github.com/"), "{} 的 GH 源需 https://github.com/: {u}", m.id);
                    assert!(u.contains("/releases/download/"), "{} 的 GH 源需指向 release 资产: {u}", m.id);
                }
                DownloadSource::HuggingFace { repo, revision } => {
                    assert!(!repo.contains("://"), "{} 的 HF repo 应为 owner/repo: {repo}", m.id);
                    assert_eq!(repo.matches('/').count(), 1, "{} 的 HF repo 应为 owner/repo: {repo}", m.id);
                    assert!(!revision.trim().is_empty(), "{} 的 HF revision 不可为空", m.id);
                    assert!(!m.entries.is_empty(), "{} 用 HF 源必须声明精选条目", m.id);
                }
            }
            for f in m.extra_files {
                match f.source {
                    DownloadSource::GithubRelease(u) => {
                        assert!(u.starts_with("https://"), "{} 附加文件需 https 地址: {u}", m.id);
                    }
                    DownloadSource::HuggingFace { repo, .. } => {
                        panic!("{} 附加文件未支持 HF 源: {repo}", m.id)
                    }
                }
                assert!(
                    !f.dest_rel.is_empty() && !f.dest_rel.contains("..")
                        && !f.dest_rel.contains('\\'),
                    "{} 附加文件落盘路径非法: {}",
                    m.id,
                    f.dest_rel
                );
            }
        }
    }

    /// 精选条目结构约束：id 唯一、恰有一条默认、文件为非空相对路径、必有主文件、体积为正
    #[test]
    fn test_download_entries_wellformed() {
        for m in SPECS {
            let mut ids: Vec<&str> = Vec::new();
            let mut defaults = 0;
            for e in m.entries {
                assert!(!e.id.trim().is_empty(), "{} 有条目 id 为空", m.id);
                assert!(!ids.contains(&e.id), "{} 条目 id 重复: {}", m.id, e.id);
                ids.push(e.id);
                if e.default {
                    defaults += 1;
                }
                assert!(e.size_gb() > 0.0, "{} 条目 {} 体积必须为正", m.id, e.id);
                for f in e.files {
                    assert!(f.size_mb > 0, "{} 条目 {} 文件 {} 体积必须为正", m.id, e.id, f.name);
                }
                assert!(
                    !e.label_zh.is_empty() && !e.label_en.is_empty(),
                    "{} 条目 {} 缺中英标签",
                    m.id,
                    e.id
                );
                assert!(!e.files.is_empty(), "{} 条目 {} 未声明文件", m.id, e.id);
                let mut has_main = false;
                for f in e.files {
                    let bad = f.name.is_empty()
                        || f.name.starts_with('/')
                        || f.name.contains("..")
                        || f.name.contains('\\');
                    assert!(!bad, "{} 条目 {} 文件名非法: {}", m.id, e.id, f.name);
                    if f.role == FileRole::Main {
                        has_main = true;
                    }
                }
                assert!(has_main, "{} 条目 {} 缺主文件（FileRole::Main）", m.id, e.id);
            }
            if !m.entries.is_empty() {
                assert_eq!(defaults, 1, "{} 必须有且仅有一条默认条目", m.id);
            }
        }
    }

    /// 有主权重条目时，条目里的主文件必须能被默认条目取到（加载端依赖它）
    #[test]
    fn test_default_entry_resolves_main() {
        for m in SPECS {
            if let Some(e) = m.default_entry() {
                assert!(e.file(FileRole::Main).is_some(), "{} 默认条目缺主文件", m.id);
                assert!(m.entry(e.id).is_some(), "{} 默认条目必须可按 id 查回", m.id);
            }
            assert!(m.entry("__not_exist__").is_none());
        }
    }

    /// 附加文件的落盘路径必须与 backend 的 ModelsRootFile 参数一致
    /// （下载落点 = 引擎读取点；两处各自的真源由本测试绑定）
    #[test]
    fn test_extra_files_match_models_root_args() {
        for m in SPECS {
            let rels: Vec<&str> = match &m.backend {
                BackendSpec::SherpaTts(s) => s
                    .cli
                    .iter()
                    .filter_map(|a| match a {
                        ArgSpec::ModelsRootFile(_, rel) => Some(*rel),
                        _ => None,
                    })
                    .collect(),
                BackendSpec::Llama(_) | BackendSpec::SherpaWs(_) => Vec::new(),
            };
            let dests: Vec<&str> = m.extra_files.iter().map(|f| f.dest_rel).collect();
            assert_eq!(rels.len(), dests.len(), "{}: ModelsRootFile 数 != extra_files 数", m.id);
            for d in &dests {
                assert!(rels.contains(d), "{}: 附加文件 {d} 未在 backend 的 ModelsRootFile 中声明", m.id);
            }
        }
    }

    /// schema 校验：id / 归一化 id / 展示名 / 归一化展示名 全部唯一
    #[test]
    fn test_spec_ids_unique() {
        let mut ids: Vec<String> = SPECS.iter().map(|m| m.id.to_string()).collect();
        let n = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), n, "id 必须唯一");

        let mut norm_ids: Vec<String> = SPECS.iter().map(|m| norm(m.id)).collect();
        norm_ids.sort();
        let m = norm_ids.len();
        norm_ids.dedup();
        assert_eq!(norm_ids.len(), m, "归一化 id 必须唯一（不允许两个条目归一化后相同）");
    }

    #[test]
    fn test_find_by_display_name() {
        assert_eq!(ModelSpec::find("Kokoro-v1_0").map(|m| m.id), Some("kokoro-multi-lang-v1_0"));
        assert_eq!(ModelSpec::find("kokoro-v1_0").map(|m| m.id), Some("kokoro-multi-lang-v1_0"));
        assert_eq!(ModelSpec::find("kokoro-multi-lang-v1_0").map(|m| m.id), Some("kokoro-multi-lang-v1_0"));
        assert_eq!(ModelSpec::find("Qwen3-ASR-0.6B").map(|m| m.id), Some("qwen3-asr-0.6b-gguf"));
        assert_eq!(ModelSpec::find("SenseVoice-int8").map(|m| m.name), Some("SenseVoice-int8"));
        assert_eq!(ModelSpec::find("bogus-model"), None);
    }

    #[test]
    fn test_find_family_prefix_fallback() {
        // 族前缀兜底：kokoro → 第一个 kokoro 条目（v1_1）
        assert_eq!(ModelSpec::find("kokoro").map(|m| m.name), Some("Kokoro-v1_1"));
        // 完整展示名 / id / 目录名三别名（"zipvoice" 等旧 e2e 短 id 不在别名集合内，
        // 运行时前端只传展示名，见 4.2 查找契约）
        assert_eq!(ModelSpec::find("ZipVoice-distill").map(|m| m.name), Some("ZipVoice-distill"));
        assert_eq!(ModelSpec::find("zipvoice-distill").map(|m| m.name), Some("ZipVoice-distill"));
    }

    /// schema 校验：TTS 条目必须声明能力字段；ASR 条目置空
    #[test]
    fn test_tts_capability_fields_present() {
        for m in SPECS.iter().filter(|m| m.kind == ModelKind::Tts) {
            assert!(!m.languages.is_empty(), "{} 必须声明 languages", m.name);
            assert!(
                matches!(m.backend, BackendSpec::SherpaTts(_)),
                "{} 必须为 SherpaTts 后端",
                m.name
            );
        }
        for m in SPECS.iter().filter(|m| m.kind == ModelKind::Asr) {
            assert!(m.languages.is_empty(), "{} 不应声明 languages", m.name);
            assert!(
                matches!(m.backend, BackendSpec::Llama(_) | BackendSpec::SherpaWs(_)),
                "{} 后端必须为 Llama/SherpaWs",
                m.name
            );
        }
    }

    /// schema 校验：File/ModelsRootFile 的文件路径必须出现在 required_files 或为已知目录参数
    #[test]
    fn test_file_args_covered_by_required_files() {
        for m in SPECS.iter() {
            if let BackendSpec::SherpaTts(spec) = &m.backend {
                for arg in spec.cli {
                    // 目录参数（espeak-ng-data）不带文件扩展名，check_ready 不校验，跳过；
                    // ModelsRootFile（vocoder）位于 models 根目录，不在模型目录 required_files 内，
                    // 存在性由引擎在 P2 解释器加载时校验。
                    let path = match arg {
                        ArgSpec::File(_, p) => Some(p),
                        _ => None,
                    };
                    if let Some(path) = path {
                        if path.contains('.') {
                            assert!(
                                spec.required_files.contains(path),
                                "{}: 必填文件 {path} 必须在 required_files 中",
                                m.name
                            );
                        }
                    }
                }
            }
        }
    }

    /// 单一真源守卫：每条描述符都能经「展示名 / 引擎 id」两种别名查回自身
    /// （旧的 `model_manager::REGISTRY` 对齐测试已随 REGISTRY 删除，见方案 §4.5）
    #[test]
    fn test_spec_alias_lookup_roundtrip() {
        for spec in SPECS {
            for alias in [spec.name, spec.id] {
                let hit = ModelSpec::find(alias)
                    .unwrap_or_else(|| panic!("{}: 别名 {alias} 查不到", spec.name));
                assert_eq!(hit.id, spec.id, "{}: 别名 {alias} 命中其它条目", spec.name);
            }
        }
    }

    /// 行内一致性：kind 与 backend 变体必须匹配（防新增模型时复制粘贴错行）
    #[test]
    fn test_kind_matches_backend() {
        for spec in SPECS {
            let ok = matches!(
                (spec.kind, &spec.backend),
                (ModelKind::Asr, BackendSpec::Llama(_))
                    | (ModelKind::Asr, BackendSpec::SherpaWs(_))
                    | (ModelKind::Tts, BackendSpec::SherpaTts(_))
            );
            assert!(
                ok,
                "{}: kind={:?} 与 backend={:?} 不匹配",
                spec.name, spec.kind, spec.backend
            );
            // framework 必须是已登记的引擎注册键（防拼错；新增框架加 FRAMEWORKS 行即可）
            assert!(
                crate::model_manager::framework_spec(spec.framework).is_some(),
                "{}: framework={} 未登记于 FRAMEWORKS",
                spec.name, spec.framework
            );
            // framework 与 backend 族必须一致（防复制粘贴改错）
            let fw_ok = match &spec.backend {
                BackendSpec::Llama(_) => spec.framework == "gguf",
                BackendSpec::SherpaWs(_) => spec.framework == "onnx",
                BackendSpec::SherpaTts(_) => spec.framework == "sherpa",
            };
            assert!(
                fw_ok,
                "{}: framework={} 与 backend={:?} 不一致",
                spec.name, spec.framework, spec.backend
            );
        }
    }

    /// 一致性：描述符 id 必须等于运行期解析出的模型目录名
    /// （model_dir(展示名) → resolve_download_dir → spec.id），锁死下载/查找/引擎三处映射
    #[test]
    fn test_spec_id_matches_resolved_model_dir() {
        for spec in SPECS {
            let dir = crate::model_manager::model_dir(spec.name);
            let leaf = dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            assert_eq!(
                leaf, spec.id,
                "{}: model_dir 解析出 {leaf}，与 spec.id ({}) 不一致",
                spec.name, spec.id
            );
        }
    }

    /// schema 校验：JoinableFiles 候选非空、无重复、≥2（确定性由声明顺序保证，不排序）
    #[test]
    fn test_joinable_files_valid() {
        for m in SPECS.iter() {
            if let BackendSpec::SherpaTts(spec) = &m.backend {
                for arg in spec.cli {
                    if let ArgSpec::JoinableFiles(_, files, sep) = arg {
                        assert!(files.len() >= 2, "{}: JoinableFiles 至少 2 个候选", m.name);
                        assert!(*sep != '\0', "{}: join 分隔符必须合法", m.name);
                        let mut seen = std::collections::HashSet::new();
                        for f in *files {
                            assert!(!f.is_empty(), "{}: JoinableFiles 候选不能为空", m.name);
                            assert!(seen.insert(f), "{}: JoinableFiles 候选不能重复: {f}", m.name);
                        }
                    }
                }
            }
        }
    }
}
