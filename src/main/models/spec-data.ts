/**
 * 模型描述符数据表 —— 由 `scripts/rust-spec-to-ts.mjs` 从 Tauri 版
 * `src-tauri/src/tts/spec.rs` 的 `SPECS` 静态表自动转换而来（勿手工编辑）。
 *
 * 字段名已从 Rust 的 snake_case 归一为 camelCase；枚举判别值改为字符串字面量。
 */

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
}

export interface CloneSpec {
  requiresText: boolean
  overridesPreset: boolean
}

export type VoiceModeSpec =
  | { type: 'fixed' }
  | { type: 'preset'; count: number; speakersFile: string | null; perLanguage: boolean }
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
  | { type: 'sherpaWs'; flag: string }
  | { type: 'sherpaTts'; cli: ArgSpec[]; requiredFiles: string[] }
  | { type: 'pytorch'; adapter: string; language: string; voice: string }

export interface ModelSpec {
  id: string
  name: string
  kind: 'asr' | 'tts'
  framework: string
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
  backend: BackendSpec
}

export const SPECS: ModelSpec[] = [

    
    {
        id: "qwen3-asr-0.6b-gguf",
        name: "Qwen3-ASR-0.6B",
        kind: 'asr',
        framework: "gguf",
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
        id: "Qwen3-ASR-1.7B",
        name: "Qwen3-ASR-1.7B",
        kind: 'asr',
        framework: "gguf",
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
        id: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
        name: "SenseVoice-int8",
        kind: 'asr',
        framework: "onnx",
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
        backend: { type: 'sherpaWs', flag: "--sense-voice-model" },
    },
    {
        id: "sherpa-onnx-paraformer-zh-small-2024-03-09",
        name: "Paraformer-zh-small",
        kind: 'asr',
        framework: "onnx",
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
        backend: { type: 'sherpaWs', flag: "--paraformer" },
    },
    
    {
        id: "kokoro-multi-lang-v1_1",
        name: "Kokoro-v1_1",
        kind: 'tts',
        framework: "sherpa",
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
        backend: { type: 'sherpaTts', cli: [
                { type: 'file', flag: "--kokoro-model", value: "model.onnx" },
                { type: 'file', flag: "--kokoro-voices", value: "voices.bin" },
                { type: 'file', flag: "--kokoro-tokens", value: "tokens.txt" },
                { type: 'file', flag: "--kokoro-data-dir", value: "espeak-ng-data" },
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
        framework: "sherpa",
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
        backend: { type: 'sherpaTts', cli: [
                { type: 'file', flag: "--kokoro-model", value: "model.onnx" },
                { type: 'file', flag: "--kokoro-voices", value: "voices.bin" },
                { type: 'file', flag: "--kokoro-tokens", value: "tokens.txt" },
                { type: 'file', flag: "--kokoro-data-dir", value: "espeak-ng-data" },
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
        framework: "sherpa",
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
        backend: { type: 'sherpaTts', cli: [
                { type: 'file', flag: "--kokoro-model", value: "model.onnx" },
                { type: 'file', flag: "--kokoro-voices", value: "voices.bin" },
                { type: 'file', flag: "--kokoro-tokens", value: "tokens.txt" },
                { type: 'file', flag: "--kokoro-data-dir", value: "espeak-ng-data" },
                
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
        framework: "sherpa",
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
        backend: { type: 'sherpaTts', cli: [
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
        id: "sherpa-onnx-zipvoice-distill",
        name: "ZipVoice-distill",
        kind: 'tts',
        framework: "sherpa",
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
        backend: { type: 'sherpaTts', cli: [
                { type: 'file', flag: "--zipvoice-encoder", value: "encoder.int8.onnx" },
                { type: 'file', flag: "--zipvoice-decoder", value: "decoder.int8.onnx" },
                { type: 'file', flag: "--zipvoice-lexicon", value: "lexicon.txt" },
                { type: 'file', flag: "--zipvoice-tokens", value: "tokens.txt" },
                { type: 'file', flag: "--zipvoice-data-dir", value: "espeak-ng-data" },
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
        id: "sherpa-onnx-pocket-tts-int8",
        name: "PocketTTS-int8",
        kind: 'tts',
        framework: "sherpa",
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
        backend: { type: 'sherpaTts', cli: [
                { type: 'file', flag: "--pocket-lm-flow", value: "lm_flow.int8.onnx" },
                { type: 'file', flag: "--pocket-lm-main", value: "lm_main.int8.onnx" },
                { type: 'file', flag: "--pocket-encoder", value: "encoder.onnx" },
                { type: 'file', flag: "--pocket-decoder", value: "decoder.onnx" },
                { type: 'file', flag: "--pocket-tokens", value: "tokens.txt" },
                { type: 'file', flag: "--pocket-data-dir", value: "espeak-ng-data" },
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
        id: "sherpa-onnx-supertonic-3-tts-int8",
        name: "Supertonic-3-int8",
        kind: 'tts',
        framework: "sherpa",
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
        backend: { type: 'sherpaTts', cli: [
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
        id: "kitten-nano-en-v0_1-fp16",
        name: "Kitten-nano-en",
        kind: 'tts',
        framework: "sherpa",
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
        backend: { type: 'sherpaTts', cli: [
                { type: 'file', flag: "--kitten-model", value: "model.onnx" },
                { type: 'file', flag: "--kitten-tokens", value: "tokens.txt" },
                { type: 'runtimeVar', flag: "--sid", key: 'speakerId' },
                { type: 'runtimeVar', flag: "--provider", key: 'provider' },
                { type: 'runtimeVar', flag: "--num-threads", key: 'numThreads' },
            ], requiredFiles: ["model.onnx", "tokens.txt"] },
    },
    
    {
        id: "whisper-tiny-pt",
        name: "Whisper-tiny-PT",
        kind: 'asr',
        framework: "pytorch",
        
        source: { type: 'huggingface', repo: "openai/whisper-tiny", revision: "169d4a4341b33bc18d8881c4b69c2e104e1cc0af" },
        entries: [{
            id: "fp32",
            labelZh: "FP32（多语，含中文）",
            labelEn: "FP32 (multilingual)",
            default: true,
            files: [
                { role: 'main', name: "model.safetensors", sizeMb: 145 },
                { role: 'extra', name: "config.json", sizeMb: 1 },
                { role: 'extra', name: "generation_config.json", sizeMb: 1 },
                { role: 'extra', name: "preprocessor_config.json", sizeMb: 1 },
                { role: 'extra', name: "tokenizer.json", sizeMb: 3 },
                { role: 'extra', name: "tokenizer_config.json", sizeMb: 1 },
                { role: 'extra', name: "special_tokens_map.json", sizeMb: 1 },
                { role: 'extra', name: "normalizer.json", sizeMb: 1 },
            ],
        }],
        sizeGb: 0.15,
        descriptionZh: "Whisper tiny · 多语 ASR · PyTorch 运行时 · 首个 PyTorch 适配模型（效果弱于 Qwen3-ASR）",
        descriptionEn: "Whisper tiny · multilingual ASR · PyTorch runtime · first PyTorch adapter model",
        available: true,
        cpu: "good",
        extraFiles: [],
        quant: null,
        
        languages: [],
        languageMode: 'fixed',
        voiceMode: { type: 'fixed' },
        backend: { type: 'pytorch', adapter: "whisper", language: "zh", voice: "" },
    },
    
    {
        id: "kokoro-82m-pt",
        name: "Kokoro-82M-PT",
        kind: 'tts',
        framework: "pytorch",
        source: { type: 'huggingface', repo: "hexgrad/Kokoro-82M", revision: "f3ff3571791e39611d31c381e3a41a3af07b4987" },
        entries: [{
            id: "v1_0-zh",
            labelZh: "v1.0 + 中文音色（女/男各一）",
            labelEn: "v1.0 + zh voices (female/male)",
            default: true,
            files: [
                { role: 'main', name: "kokoro-v1_0.pth", sizeMb: 313 },
                { role: 'extra', name: "config.json", sizeMb: 1 },
                { role: 'extra', name: "voices/zf_xiaobei.pt", sizeMb: 1 },
                { role: 'extra', name: "voices/zm_yunxi.pt", sizeMb: 1 },
            ],
        }],
        sizeGb: 0.32,
        descriptionZh: "Kokoro-82M · 中文 TTS · PyTorch 运行时（vendor 推理代码 + misaki 中文 G2P）",
        descriptionEn: "Kokoro-82M · Chinese TTS · PyTorch runtime (vendored inference + misaki zh G2P)",
        available: true,
        cpu: "good",
        extraFiles: [],
        quant: null,
        languages: ["zh"],
        languageMode: 'fixed',
        voiceMode: { type: 'fixed' },
        backend: { type: 'pytorch', adapter: "kokoro", language: "zh", voice: "zf_xiaobei" },
    },

]
