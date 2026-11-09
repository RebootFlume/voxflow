/**
 * 模型描述符数据表 —— **手工维护的唯一权威**（新增模型只改这里）。
 *
 * 历史：本文件最初由 `scripts/rust-spec-to-ts.mjs` 从 Tauri 版的 Rust 静态表转换而来。
 * 那份源表已随项目迁移到 Electron 删除，**生成器也已过时**（它的接口没有 `instruct`、
 * 没有 audio.cpp backend）；重跑它会把当前数据覆盖回旧形状。需要新模型就直接加一条 spec。
 */

import type { ModelLayer, SherpaAsrFamily, SherpaTtsFamily } from '../../shared/framework-ids'

export type { ModelLayer, SherpaAsrFamily, SherpaTtsFamily }

export interface DownloadSourceSpec {
  type: 'github' | 'huggingface'
  url?: string
  repo?: string
  revision?: string
}

export interface EntryFileSpec {
  role: 'main' | 'mmproj' | 'extra'
  name: string
  sizeMb: number
}

export interface DownloadEntrySpec {
  id: string
  labelZh: string
  labelEn: string
  files: EntryFileSpec[]
  default: boolean
}

export interface ExtraFileSpec {
  source: DownloadSourceSpec
  destRel: string
}

export interface PresetSpec {
  count: number
  speakersFile: string | null
  perLanguage: boolean
  /** 内联音色名列表（模型族用固定 voice_id 而非数字 sid 时用；优先于 speakersFile） */
  speakers?: string[]
}

export interface CloneSpec {
  requiresText: boolean
  overridesPreset: boolean
}

export type VoiceModeSpec =
  | { type: 'fixed' }
  | {
      type: 'preset'
      count: number
      speakersFile: string | null
      perLanguage: boolean
      /** 内联音色名列表（优先于 speakersFile；如 audio.cpp 的 voice_id 预设音色） */
      speakers?: string[]
    }
  | { type: 'clone'; requiresText: boolean; overridesPreset: boolean }
  | {
      type: 'presetAndClone'
      preset: PresetSpec
      clone: CloneSpec
    }

export type ArgSpec =
  | { type: 'static'; flag: string; value: string }
  | { type: 'file'; flag: string; value: string }
  | { type: 'optionalFile'; flag: string; value: string }
  | { type: 'modelsRootFile'; flag: string; value: string }
  | { type: 'joinableFiles'; flag: string; candidates: string[]; sep: string }
  | {
      type: 'runtimeVar'
      flag: string
      key:
        | 'speakerId'
        | 'language'
        | 'provider'
        | 'numThreads'
        | 'outputPath'
        | 'referenceAudio'
        | 'referenceText'
        | 'mainModelFile'
    }

export type BackendSpec =
  | { type: 'llama' }
  | {
      /** sherpa-onnx ASR（进程内 FFI）：family 决定模型路径放哪个 C 子结构体 */
      type: 'sherpaAsr'
      family: SherpaAsrFamily
      /** 该族支持指定语言时使用（空 = 自动） */
      language?: string
    }
  | {
      /** sherpa-onnx TTS（进程内 FFI）：family 决定 C 子结构体，cli 描述字段与文件 */
      type: 'sherpaTts'
      family: SherpaTtsFamily
      cli: ArgSpec[]
      requiredFiles: string[]
    }
  | {
      /**
       * audio.cpp TTS（进程内 FFI）：单一 .gguf 权重，族差异由 C 侧按 family 识别。
       *
       * 注意：首批只接**自带文本前端**的族（不依赖 eSpeak-ng 的那批），
       * 这样运行时依赖面只有 audiocpp.dll 一个文件。
       */
      type: 'audiocpp'
      /** audiocpp 的 family 名（如 "moss_tts_nano"） */
      family: string
    }

// 框架层 id（ModelLayer）定义在 ../../shared/framework-ids —— 那里是全仓库唯一的词表，
// 这里只 re-export 供调用方沿用既有 import 路径。

export interface ModelSpec {
  id: string
  name: string
  kind: 'asr' | 'tts'
  /** 所属框架层（= 磁盘目录层名 = 复合身份前缀） */
  framework: ModelLayer
  /**
   * 旧目录名（迁移用）：历史版本把这些名字直接放在 models 根下。
   * 首次启动时把命中的目录搬到 "<层>/<id>"，避免用户重新下载几个 GB。
   */
  legacyDirs?: string[]
  source: DownloadSourceSpec
  entries: DownloadEntrySpec[]
  sizeGb: number
  descriptionZh: string
  descriptionEn: string
  available: boolean
  cpu: string
  extraFiles: ExtraFileSpec[]
  quant: string | null
  languages: string[]
  languageMode: 'auto' | 'fixed' | 'select' | 'cloning'
  voiceMode: VoiceModeSpec
  /**
   * 支持自然语言音色描述（audio.cpp 的 `instruct` 请求选项）。
   * 例：Qwen3-TTS CustomVoice 用一句话描述嗓音/风格即可改写输出音色。
   */
  instruct?: boolean
  backend: BackendSpec
}

export const SPECS: ModelSpec[] = [

    
    {
        id: "qwen3-asr-0.6b",
        name: "Qwen3-ASR-0.6B",
        kind: 'asr',
        framework: "llama.cpp",
        legacyDirs: ["qwen3-asr-0.6b-gguf", "Qwen3-ASR-0.6B"],
        source: { type: 'huggingface', repo: "ggml-org/Qwen3-ASR-0.6B-GGUF", revision: "main" },
        
        
        
        
        entries: [
            {
                id: "q8_0__mp_bf16",
                labelZh: "Q8_0 主权重 + bf16 解码器 · 推荐",
                labelEn: "Q8_0 weights + bf16 decoder · Recommended",
                files: [
                    { role: 'main', name: "Qwen3-ASR-0.6B-Q8_0.gguf", sizeMb: 768 },
                    { role: 'mmproj', name: "mmproj-Qwen3-ASR-0.6B-bf16.gguf", sizeMb: 361 },
                ],
                default: true,
            },
            {
                id: "q8_0__mp_q8",
                labelZh: "Q8_0 主权重 + Q8_0 解码器（更省显存）",
                labelEn: "Q8_0 weights + Q8_0 decoder (lower VRAM)",
                files: [
                    { role: 'main', name: "Qwen3-ASR-0.6B-Q8_0.gguf", sizeMb: 768 },
                    { role: 'mmproj', name: "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf", sizeMb: 205 },
                ],
                default: false,
            },
        ],
        sizeGb: 1.10, 
        descriptionZh: "默认识别模型 · GGUF 量化 · 更快 · 内存占用更低",
        descriptionEn: "Default ASR model · GGUF quantized · faster · lower memory",
        available: true,
        cpu: "good",
        extraFiles: [],
        quant: "Q8_0",
        languages: [],
        languageMode: 'fixed',
        voiceMode: { type: 'fixed' },
        backend: { type: 'llama' },
    },
    {
        id: "qwen3-asr-1.7b",
        name: "Qwen3-ASR-1.7B",
        kind: 'asr',
        framework: "llama.cpp",
        legacyDirs: ["Qwen3-ASR-1.7B"],
        source: { type: 'huggingface', repo: "ggml-org/Qwen3-ASR-1.7B-GGUF", revision: "main" },
        
        entries: [
            {
                id: "q8_0__mp_bf16",
                labelZh: "Q8_0 主权重 + bf16 解码器 · 推荐",
                labelEn: "Q8_0 weights + bf16 decoder · Recommended",
                files: [
                    { role: 'main', name: "Qwen3-ASR-1.7B-Q8_0.gguf", sizeMb: 2065 },
                    { role: 'mmproj', name: "mmproj-Qwen3-ASR-1.7B-bf16.gguf", sizeMb: 612 },
                ],
                default: true,
            },
            {
                id: "q8_0__mp_q8",
                labelZh: "Q8_0 主权重 + Q8_0 解码器（更省显存）",
                labelEn: "Q8_0 weights + Q8_0 decoder (lower VRAM)",
                files: [
                    { role: 'main', name: "Qwen3-ASR-1.7B-Q8_0.gguf", sizeMb: 2065 },
                    { role: 'mmproj', name: "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf", sizeMb: 339 },
                ],
                default: false,
            },
        ],
        sizeGb: 2.61, 
        descriptionZh: "更准 · GGUF 量化 · 需要更多内存/显存",
        descriptionEn: "More accurate · GGUF quantized · needs more memory",
        available: true,
        cpu: "slow",
        extraFiles: [],
        quant: "Q8_0",
        languages: [],
        languageMode: 'fixed',
        voiceMode: { type: 'fixed' },
        backend: { type: 'llama' },
    },
    {
        id: "qwen3-asr-0.6b",
        name: "Qwen3-ASR-0.6B",
        kind: 'asr',
        framework: "audio.cpp",
        legacyDirs: ["audiocpp-qwen3-asr-0.6b", "Qwen3-ASR-0.6B (audio.cpp)"],
        source: { type: 'huggingface', repo: "audio-cpp/audio.cpp-gguf", revision: "main" },
        entries: [
            {
                id: "q8_0",
                labelZh: "Q8_0 · 单文件 · 推荐",
                labelEn: "Q8_0 · single file · Recommended",
                files: [
                    { role: 'main', name: "Qwen3-ASR-0.6B-GGUF/qwen3-asr-0.6b-q8_0.gguf", sizeMb: 1098 },
                ],
                default: true,
            },
            {
                id: "f16",
                labelZh: "F16 · 单文件（更准、更大）",
                labelEn: "F16 · single file (more accurate, larger)",
                files: [
                    { role: 'main', name: "Qwen3-ASR-0.6B-GGUF/qwen3-asr-0.6b-f16.gguf", sizeMb: 1793.5 },
                ],
                default: false,
            },
        ],
        sizeGb: 1.10,
        descriptionZh: "与上一条同源模型 · audio.cpp 运行时 · 自带文本前端",
        descriptionEn: "Same model as above · audio.cpp runtime · self-contained frontend",
        available: true,
        cpu: "good",
        extraFiles: [],
        quant: "Q8_0",
        languages: [],
        languageMode: 'fixed',
        voiceMode: { type: 'fixed' },
        backend: { type: 'audiocpp', family: 'qwen3_asr' },
    },
    {
        id: "qwen3-asr-1.7b",
        name: "Qwen3-ASR-1.7B",
        kind: 'asr',
        framework: "audio.cpp",
        legacyDirs: ["audiocpp-qwen3-asr-1.7b", "Qwen3-ASR-1.7B (audio.cpp)"],
        source: { type: 'huggingface', repo: "audio-cpp/audio.cpp-gguf", revision: "main" },
        entries: [
            {
                id: "q8_0",
                labelZh: "Q8_0 · 单文件 · 推荐",
                labelEn: "Q8_0 · single file · Recommended",
                files: [
                    { role: 'main', name: "Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf", sizeMb: 2358.5 },
                ],
                default: true,
            },
            {
                id: "f16",
                labelZh: "F16 · 单文件（更准、更大）",
                labelEn: "F16 · single file (more accurate, larger)",
                files: [
                    { role: 'main', name: "Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-f16.gguf", sizeMb: 3898.3 },
                ],
                default: false,
            },
        ],
        sizeGb: 2.36,
        descriptionZh: "Qwen3-ASR 1.7B · 31 语种与中文方言 · audio.cpp 运行时",
        descriptionEn: "Qwen3-ASR 1.7B · 31 languages + Chinese dialects · audio.cpp runtime",
        available: true,
        cpu: "slow",
        extraFiles: [],
        quant: "Q8_0",
        languages: [],
        languageMode: 'fixed',
        voiceMode: { type: 'fixed' },
        backend: { type: 'audiocpp', family: 'qwen3_asr' },
    },
    {
        id: "fun-asr-nano",
        name: "Fun-ASR-Nano",
        kind: 'asr',
        framework: "audio.cpp",
        legacyDirs: ["audiocpp-fun-asr-nano", "Fun-ASR-Nano (audio.cpp)"],
        source: { type: 'huggingface', repo: "FunAudioLLM/Fun-ASR-Nano-2512-GGUF", revision: "main" },
        entries: [
            {
                id: "q8_0",
                labelZh: "Q8_0 · 单文件 · 推荐",
                labelEn: "Q8_0 · single file · Recommended",
                files: [{ role: 'main', name: "fun-asr-nano-2512-q8_0.gguf", sizeMb: 996.9 }],
                default: true,
            },
            {
                id: "f16",
                labelZh: "F16 · 单文件（更准、更大）",
                labelEn: "F16 · single file (more accurate, larger)",
                files: [{ role: 'main', name: "fun-asr-nano-2512-f16.gguf", sizeMb: 1598.1 }],
                default: false,
            },
        ],
        sizeGb: 0.97,
        descriptionZh: "Fun-ASR-Nano 2512 · 中/英/日 · 自带 ITN 数字规范化 · audio.cpp 运行时",
        descriptionEn: "Fun-ASR-Nano 2512 · zh/en/ja · built-in ITN · audio.cpp runtime",
        available: true,
        cpu: "good",
        extraFiles: [],
        quant: "Q8_0",
        languages: [],
        languageMode: 'fixed',
        voiceMode: { type: 'fixed' },
        backend: { type: 'audiocpp', family: 'fun_asr_nano' },
    },
    {
        id: "moss-transcribe-diarize",
        name: "MOSS-Transcribe-Diarize",
        kind: 'asr',
        framework: "audio.cpp",
        legacyDirs: ["audiocpp-moss-transcribe-diarize", "MOSS-Transcribe-Diarize (audio.cpp)"],
        source: { type: 'huggingface', repo: "audio-cpp/audio.cpp-gguf", revision: "main" },
        entries: [
            {
                id: "q8_0",
                labelZh: "Q8_0 · 1.1GB · 推荐",
                labelEn: "Q8_0 · 1.1GB · Recommended",
                files: [
                    { role: 'main', name: "MOSS-Transcribe-Diarize-GGUF/moss-transcribe-diarize-q8_0.gguf", sizeMb: 1079.7 },
                ],
                default: true,
            },
            {
                id: "q4_k",
                labelZh: "Q4_K · 723MB（更小）",
                labelEn: "Q4_K · 723MB (smaller)",
                files: [
                    { role: 'main', name: "MOSS-Transcribe-Diarize-GGUF/moss-transcribe-diarize-q4_k.gguf", sizeMb: 723.2 },
                ],
                default: false,
            },
            {
                id: "bf16",
                labelZh: "BF16 · 1.7GB（更准）",
                labelEn: "BF16 · 1.7GB (more accurate)",
                files: [
                    { role: 'main', name: "MOSS-Transcribe-Diarize-GGUF/moss-transcribe-diarize-bf16.gguf", sizeMb: 1748.1 },
                ],
                default: false,
            },
        ],
        sizeGb: 1.08,
        descriptionZh: "MOSS 转写 + 说话人分离（带时间戳）· 50+ 语言 · audio.cpp 运行时",
        descriptionEn: "MOSS transcription with speaker diarization + timestamps · 50+ languages · audio.cpp runtime",
        available: true,
        cpu: "slow",
        extraFiles: [],
        quant: "Q8_0",
        languages: [],
        languageMode: 'fixed',
        voiceMode: { type: 'fixed' },
        backend: { type: 'audiocpp', family: 'moss_transcribe_diarize' },
    },
    {
        id: "sense-voice-int8",
        name: "SenseVoice-int8",
        kind: 'asr',
        framework: "sherpa-onnx",
        legacyDirs: ["sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17", "SenseVoice-int8"],
        sizeGb: 0.23,
        descriptionZh: "中文全能 · 中英日韩粤 5 语 · 情感/事件/时间戳",
        descriptionEn: "All-round Chinese · zh/en/ja/ko/yue · emotion/event/timestamps",
        available: true,
        cpu: "good",
        source: { type: 'github', url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2" },
        entries: [],
        extraFiles: [],
        quant: null,
        languages: [],
        languageMode: 'fixed',
        voiceMode: { type: 'fixed' },
        backend: { type: 'sherpaAsr', family: 'sense_voice' },
    },
    {
        id: "paraformer-zh-small",
        name: "Paraformer-zh-small",
        kind: 'asr',
        framework: "sherpa-onnx",
        legacyDirs: ["sherpa-onnx-paraformer-zh-small-2024-03-09", "Paraformer-zh-small"],
        sizeGb: 0.1,
        descriptionZh: "中文超小 · 74MB · 低端 CPU 设备首选",
        descriptionEn: "Tiny Chinese · 74MB · best for low-end CPU",
        available: true,
        cpu: "good",
        source: { type: 'github', url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2" },
        entries: [],
        extraFiles: [],
        quant: null,
        languages: [],
        languageMode: 'fixed',
        voiceMode: { type: 'fixed' },
        backend: { type: 'sherpaAsr', family: 'paraformer' },
    },
    
    {
        id: "kokoro-multi-lang-v1_1",
        name: "Kokoro-v1_1",
        kind: 'tts',
        framework: "sherpa-onnx",
        legacyDirs: ["Kokoro-v1_1"],
        sizeGb: 0.32,
        descriptionZh: "Kokoro 多语言 v1.1 · 中英103音色 · 纯端到端 · sherpa-onnx 推荐",
        descriptionEn: "Kokoro multi-lang v1.1 · zh/en 103 voices · E2E · sherpa-onnx recommended",
        available: true,
        cpu: "good",
        source: { type: 'github', url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2" },
        entries: [],
        extraFiles: [],
        quant: null,
        languages: ["zh", "en"],
        languageMode: 'auto',
        voiceMode: { type: 'preset', count: 103, speakersFile: "speakers.json", perLanguage: false },
        backend: { type: 'sherpaTts', family: 'kokoro', cli: [
                { type: 'file', flag: "--kokoro-model", value: "model.onnx" },
                { type: 'file', flag: "--kokoro-voices", value: "voices.bin" },
                { type: 'file', flag: "--kokoro-tokens", value: "tokens.txt" },
                { type: 'joinableFiles', flag: "--kokoro-lexicon", candidates: ["lexicon-us-en.txt", "lexicon-gb-en.txt", "lexicon-zh.txt"], sep: ',' },
                { type: 'joinableFiles', flag: "--tts-rule-fsts", candidates: ["date-zh.fst", "phone-zh.fst", "number-zh.fst"], sep: ',' },
                { type: 'runtimeVar', flag: "--sid", key: 'speakerId' },
                { type: 'runtimeVar', flag: "--provider", key: 'provider' },
                { type: 'runtimeVar', flag: "--num-threads", key: 'numThreads' },
            ], requiredFiles: [
                "model.onnx",
                "voices.bin",
                "tokens.txt",
                "lexicon-zh.txt",
                "lexicon-us-en.txt",
            ] },
    },
    {
        id: "kokoro-multi-lang-v1_0",
        name: "Kokoro-v1_0",
        kind: 'tts',
        framework: "sherpa-onnx",
        legacyDirs: ["Kokoro-v1_0"],
        sizeGb: 0.32,
        descriptionZh: "Kokoro 多语言 v1.0 · 中英53音色 · 纯端到端",
        descriptionEn: "Kokoro multi-lang v1.0 · zh/en 53 voices · E2E",
        available: true,
        cpu: "good",
        source: { type: 'github', url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2" },
        entries: [],
        extraFiles: [],
        quant: null,
        languages: ["zh", "en"],
        languageMode: 'auto',
        voiceMode: { type: 'preset', count: 53, speakersFile: "speakers.json", perLanguage: false },
        backend: { type: 'sherpaTts', family: 'kokoro', cli: [
                { type: 'file', flag: "--kokoro-model", value: "model.onnx" },
                { type: 'file', flag: "--kokoro-voices", value: "voices.bin" },
                { type: 'file', flag: "--kokoro-tokens", value: "tokens.txt" },
                { type: 'joinableFiles', flag: "--kokoro-lexicon", candidates: ["lexicon-us-en.txt", "lexicon-gb-en.txt", "lexicon-zh.txt"], sep: ',' },
                { type: 'joinableFiles', flag: "--tts-rule-fsts", candidates: ["date-zh.fst", "phone-zh.fst", "number-zh.fst"], sep: ',' },
                { type: 'runtimeVar', flag: "--sid", key: 'speakerId' },
                { type: 'runtimeVar', flag: "--provider", key: 'provider' },
                { type: 'runtimeVar', flag: "--num-threads", key: 'numThreads' },
            ], requiredFiles: [
                "model.onnx",
                "voices.bin",
                "tokens.txt",
                "lexicon-zh.txt",
                "lexicon-us-en.txt",
            ] },
    },
    {
        id: "kokoro-en-v0_19",
        name: "Kokoro-en-v0_19",
        kind: 'tts',
        framework: "sherpa-onnx",
        legacyDirs: ["Kokoro-en-v0_19"],
        sizeGb: 0.32,
        descriptionZh: "Kokoro 英文 v0.19 · 11音色 · 纯端到端",
        descriptionEn: "Kokoro English v0.19 · 11 voices · E2E",
        available: true,
        cpu: "good",
        source: { type: 'github', url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2" },
        entries: [],
        extraFiles: [],
        quant: null,
        languages: ["en"],
        languageMode: 'fixed',
        voiceMode: { type: 'preset', count: 11, speakersFile: "speakers.json", perLanguage: false },
        backend: { type: 'sherpaTts', family: 'kokoro', cli: [
                { type: 'file', flag: "--kokoro-model", value: "model.onnx" },
                { type: 'file', flag: "--kokoro-voices", value: "voices.bin" },
                { type: 'file', flag: "--kokoro-tokens", value: "tokens.txt" },
                
                { type: 'joinableFiles', flag: "--kokoro-lexicon", candidates: ["lexicon-us-en.txt", "lexicon-gb-en.txt"], sep: ',' },
                { type: 'runtimeVar', flag: "--sid", key: 'speakerId' },
                { type: 'runtimeVar', flag: "--provider", key: 'provider' },
                { type: 'runtimeVar', flag: "--num-threads", key: 'numThreads' },
            ], requiredFiles: ["model.onnx", "voices.bin", "tokens.txt"] },
    },
    {
        id: "matcha-icefall-zh-baker",
        name: "Matcha-zh-baker",
        kind: 'tts',
        framework: "sherpa-onnx",
        legacyDirs: ["Matcha-zh-baker"],
        sizeGb: 0.3,
        descriptionZh: "Matcha 中文 · 高质量 · 纯端到端",
        descriptionEn: "Matcha Chinese · high quality · E2E",
        available: true,
        cpu: "good",
        source: { type: 'github', url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/matcha-icefall-zh-baker.tar.bz2" },
        entries: [],
        
        
        extraFiles: [{
            source: { type: 'github', url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos-22khz-univ.onnx" },
            destRel: "vocos-22khz-univ.onnx",
        }],
        quant: null,
        
        
        languages: ["zh"],
        languageMode: 'fixed',
        voiceMode: { type: 'fixed' },
        backend: { type: 'sherpaTts', family: 'matcha', cli: [
                { type: 'runtimeVar', flag: "--matcha-acoustic-model", key: 'mainModelFile' },
                { type: 'modelsRootFile', flag: "--matcha-vocoder", value: "vocos-22khz-univ.onnx" },
                { type: 'file', flag: "--matcha-tokens", value: "tokens.txt" },
                
                
                
                
                { type: 'file', flag: "--matcha-lexicon", value: "lexicon.txt" },
                
                { type: 'joinableFiles', flag: "--tts-rule-fsts", candidates: ["date.fst", "number.fst", "phone.fst"], sep: ',' },
                { type: 'runtimeVar', flag: "--sid", key: 'speakerId' },
                { type: 'runtimeVar', flag: "--provider", key: 'provider' },
                { type: 'runtimeVar', flag: "--num-threads", key: 'numThreads' },
            ], requiredFiles: ["model-steps-3.onnx", "tokens.txt", "lexicon.txt"] },
    },
    {
        id: "zipvoice-distill",
        name: "ZipVoice-distill",
        kind: 'tts',
        framework: "sherpa-onnx",
        legacyDirs: ["sherpa-onnx-zipvoice-distill", "ZipVoice-distill"],
        sizeGb: 0.4,
        descriptionZh: "ZipVoice 蒸馏 · 中英 · 语音克隆 · 纯端到端",
        descriptionEn: "ZipVoice distill · zh/en · voice clone · E2E",
        available: true,
        cpu: "good",
        source: { type: 'github', url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2" },
        entries: [],
        
        extraFiles: [{
            source: { type: 'github', url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos_24khz.onnx" },
            destRel: "vocos_24khz.onnx",
        }],
        quant: null,
        languages: ["zh", "en"],
        languageMode: 'cloning',
        voiceMode: { type: 'clone', requiresText: true, overridesPreset: true },
        backend: { type: 'sherpaTts', family: 'zipvoice', cli: [
                { type: 'file', flag: "--zipvoice-encoder", value: "encoder.int8.onnx" },
                { type: 'file', flag: "--zipvoice-decoder", value: "decoder.int8.onnx" },
                { type: 'file', flag: "--zipvoice-lexicon", value: "lexicon.txt" },
                { type: 'file', flag: "--zipvoice-tokens", value: "tokens.txt" },
                { type: 'modelsRootFile', flag: "--zipvoice-vocoder", value: "vocos_24khz.onnx" },
                { type: 'runtimeVar', flag: "--reference-audio", key: 'referenceAudio' },
                { type: 'runtimeVar', flag: "--reference-text", key: 'referenceText' },
                { type: 'runtimeVar', flag: "--provider", key: 'provider' },
                { type: 'runtimeVar', flag: "--num-threads", key: 'numThreads' },
            ], requiredFiles: [
                "encoder.int8.onnx",
                "decoder.int8.onnx",
                "lexicon.txt",
                "tokens.txt",
            ] },
    },
    {
        id: "pocket-tts-int8",
        name: "PocketTTS-int8",
        kind: 'tts',
        framework: "sherpa-onnx",
        legacyDirs: ["sherpa-onnx-pocket-tts-int8", "PocketTTS-int8"],
        sizeGb: 0.5,
        descriptionZh: "Pocket TTS int8 · 快速低延迟 · 纯端到端（克隆未接线）",
        descriptionEn: "Pocket TTS int8 · fast · E2E (clone not wired)",
        available: true,
        cpu: "good",
        source: { type: 'github', url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2" },
        entries: [],
        extraFiles: [],
        quant: null,
        
        
        
        languages: ["en"],
        languageMode: 'fixed',
        voiceMode: { type: 'fixed' },
        backend: { type: 'sherpaTts', family: 'pocket', cli: [
                { type: 'file', flag: "--pocket-lm-flow", value: "lm_flow.int8.onnx" },
                { type: 'file', flag: "--pocket-lm-main", value: "lm_main.int8.onnx" },
                { type: 'file', flag: "--pocket-encoder", value: "encoder.onnx" },
                { type: 'file', flag: "--pocket-decoder", value: "decoder.onnx" },
                { type: 'file', flag: "--pocket-tokens", value: "tokens.txt" },
                { type: 'runtimeVar', flag: "--provider", key: 'provider' },
                { type: 'runtimeVar', flag: "--num-threads", key: 'numThreads' },
            ], requiredFiles: [
                "lm_flow.int8.onnx",
                "lm_main.int8.onnx",
                "encoder.onnx",
                "decoder.onnx",
                "tokens.txt",
            ] },
    },
    {
        id: "supertonic-3-tts-int8",
        name: "Supertonic-3-int8",
        kind: 'tts',
        framework: "sherpa-onnx",
        legacyDirs: ["sherpa-onnx-supertonic-3-tts-int8", "Supertonic-3-int8"],
        sizeGb: 0.6,
        descriptionZh: "Supertonic 3 · 31语言 · 高质量 · 纯端到端",
        descriptionEn: "Supertonic 3 · 31 languages · high quality · E2E",
        available: true,
        cpu: "good",
        source: { type: 'github', url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2" },
        entries: [],
        extraFiles: [],
        quant: null,
        languages: [
            "ar", "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hi", "hu",
            "id", "it", "ja", "ko", "lv", "lt", "pl", "pt", "ro", "ru", "sk", "sl", "es", "sv",
            "tr", "uk", "vi",
        ],
        languageMode: 'select',
        voiceMode: { type: 'preset', count: 10, speakersFile: null, perLanguage: true },
        backend: { type: 'sherpaTts', family: 'supertonic', cli: [
                { type: 'file', flag: "--supertonic-duration-predictor", value: "duration_predictor.int8.onnx" },
                { type: 'file', flag: "--supertonic-text-encoder", value: "text_encoder.int8.onnx" },
                { type: 'file', flag: "--supertonic-vector-estimator", value: "vector_estimator.int8.onnx" },
                { type: 'file', flag: "--supertonic-vocoder", value: "vocoder.int8.onnx" },
                { type: 'file', flag: "--supertonic-tts-json", value: "tts.json" },
                { type: 'file', flag: "--supertonic-unicode-indexer", value: "unicode_indexer.bin" },
                { type: 'file', flag: "--supertonic-voice-style", value: "voice.bin" },
                { type: 'runtimeVar', flag: "--sid", key: 'speakerId' },
                { type: 'runtimeVar', flag: "--lang", key: 'language' },
                { type: 'runtimeVar', flag: "--provider", key: 'provider' },
                { type: 'runtimeVar', flag: "--num-threads", key: 'numThreads' },
            ], requiredFiles: [
                "duration_predictor.int8.onnx",
                "text_encoder.int8.onnx",
                "vector_estimator.int8.onnx",
                "vocoder.int8.onnx",
                "tts.json",
                "unicode_indexer.bin",
                "voice.bin",
            ] },
    },
    {
        id: "kitten-nano-en-v0_1_fp16",
        name: "Kitten-nano-en",
        kind: 'tts',
        framework: "sherpa-onnx",
        legacyDirs: ["Kitten-nano-en"],
        sizeGb: 0.2,
        descriptionZh: "Kitten nano · 轻量快速 · 英文 · 纯端到端",
        descriptionEn: "Kitten nano · lightweight · en · E2E",
        available: true,
        cpu: "good",
        source: { type: 'github', url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_1-fp16.tar.bz2" },
        entries: [],
        extraFiles: [],
        quant: null,
        languages: ["en"],
        languageMode: 'fixed',
        voiceMode: { type: 'fixed' },
        backend: { type: 'sherpaTts', family: 'kitten', cli: [
                { type: 'file', flag: "--kitten-model", value: "model.onnx" },
                { type: 'file', flag: "--kitten-tokens", value: "tokens.txt" },
                { type: 'runtimeVar', flag: "--sid", key: 'speakerId' },
                { type: 'runtimeVar', flag: "--provider", key: 'provider' },
                { type: 'runtimeVar', flag: "--num-threads", key: 'numThreads' },
            ], requiredFiles: ["model.onnx", "tokens.txt"] },
    },
    {
        id: "moss-tts-nano-100m",
        name: "MOSS-TTS-Nano",
        kind: 'tts',
        framework: "audio.cpp",
        legacyDirs: ["audiocpp-moss-tts-nano-100m", "MOSS-TTS-Nano"],
        sizeGb: 0.19,
        descriptionZh: "MOSS TTS Nano 100M · 中英等多语 · 自带文本前端 · audio.cpp",
        descriptionEn: "MOSS TTS Nano 100M · multilingual · built-in frontend · audio.cpp",
        available: true,
        cpu: "good",
        // audio.cpp 的 GGUF 权重统一放在同一个 HF 仓库（<Model>-GGUF/<file>.gguf 子目录）
        source: { type: 'huggingface', repo: "audio-cpp/audio.cpp-gguf", revision: "main" },
        entries: [{
            id: "moss-nano-q8_0",
            labelZh: "Q8_0 · 193MB（推荐）",
            labelEn: "Q8_0 · 193MB (recommended)",
            files: [{
                role: 'main',
                name: "MOSS-TTS-Nano-100M-GGUF/moss-tts-nano-100m-q8_0.gguf",
                sizeMb: 184.4,
            }],
            default: true,
        }],
        extraFiles: [],
        quant: "q8_0",
        languages: ["zh", "en", "ja", "ko", "de", "fr", "es", "ru"],
        languageMode: 'auto',
        voiceMode: { type: 'fixed' },
        backend: { type: 'audiocpp', family: 'moss_tts_nano' },
    },
    {
        id: "qwen3-tts-customvoice",
        name: "Qwen3-TTS-1.7B (CustomVoice)",
        kind: 'tts',
        framework: "audio.cpp",
        legacyDirs: ["audiocpp-qwen3-tts-customvoice", "Qwen3-TTS-1.7B (CustomVoice)"],
        sizeGb: 2.69,
        descriptionZh: "Qwen3-TTS 1.7B · 9 个预设音色 · 中英日韩德法俄葡西意 · audio.cpp",
        descriptionEn: "Qwen3-TTS 1.7B · 9 preset voices · zh/en/ja/ko/de/fr/ru/pt/es/it · audio.cpp",
        available: true,
        cpu: "slow",
        source: { type: 'huggingface', repo: "audio-cpp/audio.cpp-gguf", revision: "main" },
        entries: [
            {
                id: "q8_0",
                labelZh: "Q8_0 · 2.7GB（推荐）",
                labelEn: "Q8_0 · 2.7GB (recommended)",
                files: [{
                    role: 'main',
                    name: "Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf",
                    sizeMb: 2686.6,
                }],
                default: true,
            },
            {
                id: "bf16",
                labelZh: "BF16 · 4.0GB（更准）",
                labelEn: "BF16 · 4.0GB (more accurate)",
                files: [{
                    role: 'main',
                    name: "Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/qwen3-tts-12hz-1.7b-customvoice-bf16.gguf",
                    sizeMb: 3985.6,
                }],
                default: false,
            },
        ],
        extraFiles: [],
        quant: "Q8_0",
        languages: ["zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
        languageMode: 'select',
        voiceMode: {
            type: 'preset',
            count: 9,
            speakersFile: null,
            perLanguage: false,
            // audio.cpp 的 voice_id 预设音色（Qwen3-TTS CustomVoice checkpoint 的 9 个命名说话人）
            speakers: ["vivian", "serena", "uncle_fu", "dylan", "eric", "ryan", "aiden", "ono_anna", "sohee"],
        },
        // CustomVoice checkpoint 的 instruct 可改写音色风格（实测同 seed 输出明显不同）
        instruct: true,
        backend: { type: 'audiocpp', family: 'qwen3_tts' },
    },
    {
        id: "qwen3-tts-base-0.6b",
        name: "Qwen3-TTS-0.6B (Base)",
        kind: 'tts',
        framework: "audio.cpp",
        legacyDirs: [],
        sizeGb: 1.9,
        descriptionZh: "Qwen3-TTS 0.6B Base · 仅克隆音色（需参考音频+参考文本）· audio.cpp",
        descriptionEn: "Qwen3-TTS 0.6B Base · clone-only (reference audio + text) · audio.cpp",
        available: true,
        cpu: "slow",
        source: { type: 'huggingface', repo: "audio-cpp/audio.cpp-gguf", revision: "main" },
        entries: [
            {
                id: "q8_0",
                labelZh: "Q8_0 · 1.9GB（推荐）",
                labelEn: "Q8_0 · 1.9GB (recommended)",
                files: [{
                    role: 'main',
                    name: "Qwen3-TTS-12Hz-0.6B-Base-GGUF/qwen3-tts-12hz-0.6b-base-q8_0.gguf",
                    sizeMb: 1899.0,
                }],
                default: true,
            },
            {
                id: "bf16",
                labelZh: "BF16 · 2.4GB（更准）",
                labelEn: "BF16 · 2.4GB (more accurate)",
                files: [{
                    role: 'main',
                    name: "Qwen3-TTS-12Hz-0.6B-Base-GGUF/qwen3-tts-12hz-0.6b-base-bf16.gguf",
                    sizeMb: 2399.6,
                }],
                default: false,
            },
        ],
        extraFiles: [],
        quant: "q8_0",
        languages: ["zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
        languageMode: 'select',
        // Base 只有克隆：必须提供参考音频 + 参考文本，没有预设音色
        voiceMode: { type: 'clone', requiresText: true, overridesPreset: false },
        backend: { type: 'audiocpp', family: 'qwen3_tts' },
    },
    {
        id: "qwen3-tts-base-1.7b",
        name: "Qwen3-TTS-1.7B (Base)",
        kind: 'tts',
        framework: "audio.cpp",
        legacyDirs: [],
        sizeGb: 2.57,
        descriptionZh: "Qwen3-TTS 1.7B Base · 仅克隆音色（需参考音频+参考文本）· audio.cpp",
        descriptionEn: "Qwen3-TTS 1.7B Base · clone-only (reference audio + text) · audio.cpp",
        available: true,
        cpu: "slow",
        source: { type: 'huggingface', repo: "audio-cpp/audio.cpp-gguf", revision: "main" },
        entries: [
            {
                id: "q8_0_v2",
                labelZh: "Q8_0_v2 · 2.6GB（推荐）",
                labelEn: "Q8_0_v2 · 2.6GB (recommended)",
                files: [{
                    role: 'main',
                    name: "Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf",
                    sizeMb: 2570.3,
                }],
                default: true,
            },
            {
                id: "bf16",
                labelZh: "BF16 · 4.0GB（更准）",
                labelEn: "BF16 · 4.0GB (more accurate)",
                files: [{
                    role: 'main',
                    name: "Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-bf16.gguf",
                    sizeMb: 4008.5,
                }],
                default: false,
            },
        ],
        extraFiles: [],
        quant: "q8_0",
        languages: ["zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
        languageMode: 'select',
        // Base 只有克隆：必须提供参考音频 + 参考文本，没有预设音色
        voiceMode: { type: 'clone', requiresText: true, overridesPreset: false },
        backend: { type: 'audiocpp', family: 'qwen3_tts' },
    },

]
