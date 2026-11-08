/**
 * sherpa-onnx C API 的 koffi 绑定层：**只声明 ABI，不含任何推理逻辑**。
 *
 * 与 llama-ffi 的 bindings 同一层语义：
 * - 结构体布局 = ABI，必须与 `include/sherpa-onnx/c-api/c-api.h` 严格一致（字段顺序不能改）。
 * - 换 sherpa-onnx 版本时只需要改这一个文件。
 *
 * 两个关键坑（都踩过）：
 * 1. `sherpa-onnx-c-api.dll` 是**延迟加载** onnxruntime.dll 的。Windows 会抢先加载
 *    机器上别处的旧版本 onnxruntime（实测拿到 1.17.1，而随包的是 1.27.1），
 *    结果是 `The requested API version [27] is not available`。
 *    解法：加载 c-api 之前，先按**绝对路径**显式预加载同目录的 onnxruntime.dll。
 * 2. 依赖 DLL（onnxruntime_providers_cuda.dll → cublas/cudnn…）靠 PATH 找，
 *    所以运行时目录要插到 PATH 最前。
 */

import { delimiter, join } from 'node:path'
import koffi from 'koffi'

const C = 'const char *'
const voidPtr = 'void *'

/* ------------------------------------------------------------------ *
 * ASR：结构体（顺序 = ABI，见 c-api.h）
 * ------------------------------------------------------------------ */

/** 特征配置：采样率 + 特征维度 */
const featureConfig = koffi.struct('SherpaFeatureConfig', {
  sample_rate: 'int32_t',
  feature_dim: 'int32_t'
})

/** 单一模型路径的族（paraformer/nemo_ctc/tdnn/dolphin/zipformer_ctc/wenet_ctc/omnilingual/medasr/fire_red_asr_ctc） */
const oneModelConfig = koffi.struct('SherpaOneModelConfig', { model: C })

const transducerConfig = koffi.struct('SherpaTransducerConfig', {
  encoder: C,
  decoder: C,
  joiner: C
})

const whisperConfig = koffi.struct('SherpaWhisperConfig', {
  encoder: C,
  decoder: C,
  language: C,
  task: C,
  tail_paddings: 'int32_t',
  enable_token_timestamps: 'int32_t',
  enable_segment_timestamps: 'int32_t'
})

const senseVoiceConfig = koffi.struct('SherpaSenseVoiceConfig', {
  model: C,
  language: C,
  use_itn: 'int32_t'
})

const moonshineConfig = koffi.struct('SherpaMoonshineConfig', {
  preprocessor: C,
  encoder: C,
  uncached_decoder: C,
  cached_decoder: C,
  merged_decoder: C
})

const fireRedConfig = koffi.struct('SherpaFireRedConfig', { encoder: C, decoder: C })

const canaryConfig = koffi.struct('SherpaCanaryConfig', {
  encoder: C,
  decoder: C,
  src_lang: C,
  tgt_lang: C,
  use_pnc: 'int32_t'
})

const funAsrNanoConfig = koffi.struct('SherpaFunAsrNanoConfig', {
  encoder_adaptor: C,
  llm: C,
  embedding: C,
  tokenizer: C,
  system_prompt: C,
  user_prompt: C,
  max_new_tokens: 'int32_t',
  temperature: 'float',
  top_p: 'float',
  seed: 'int32_t',
  language: C,
  itn: 'int32_t',
  hotwords: C
})

const qwen3AsrConfig = koffi.struct('SherpaQwen3AsrConfig', {
  conv_frontend: C,
  encoder: C,
  decoder: C,
  tokenizer: C,
  max_total_len: 'int32_t',
  max_new_tokens: 'int32_t',
  temperature: 'float',
  top_p: 'float',
  seed: 'int32_t',
  hotwords: C
})

const cohereConfig = koffi.struct('SherpaCohereConfig', {
  encoder: C,
  decoder: C,
  language: C,
  use_punct: 'int32_t',
  use_itn: 'int32_t'
})

/** 模型配置：各族模型参数 + 通用项（tokens / 线程 / provider …） */
const modelConfig = koffi.struct('SherpaModelConfig', {
  transducer: transducerConfig,
  paraformer: oneModelConfig,
  nemo_ctc: oneModelConfig,
  whisper: whisperConfig,
  tdnn: oneModelConfig,
  tokens: C,
  num_threads: 'int32_t',
  debug: 'int32_t',
  provider: C,
  model_type: C,
  modeling_unit: C,
  bpe_vocab: C,
  telespeech_ctc: C,
  sense_voice: senseVoiceConfig,
  moonshine: moonshineConfig,
  fire_red_asr: fireRedConfig,
  dolphin: oneModelConfig,
  zipformer_ctc: oneModelConfig,
  canary: canaryConfig,
  wenet_ctc: oneModelConfig,
  omnilingual: oneModelConfig,
  medasr: oneModelConfig,
  funasr_nano: funAsrNanoConfig,
  fire_red_asr_ctc: oneModelConfig,
  qwen3_asr: qwen3AsrConfig,
  cohere_transcribe: cohereConfig
})

const lmConfig = koffi.struct('SherpaLmConfig', { model: C, scale: 'float' })

const homophoneReplacerConfig = koffi.struct('SherpaHomophoneReplacerConfig', {
  dict_dir: C,
  lexicon: C,
  rule_fsts: C
})

/** HLG/FST 离线 CTC 解码配置（v2.0.1 起识别器配置的最后一个字段） */
const ctcFstDecoderConfig = koffi.struct('SherpaCtcFstDecoderConfig', {
  graph: C,
  max_active: 'int32_t'
})

/**
 * 识别器配置
 *
 * v2.0.1：尾部新增 `ctc_fst_decoder_config`。该结构体以指针形式传给 C，
 * C 会按自己的 sizeof 读取全部字段 —— 少一个尾部字段就是越界读，
 * 升级 sherpa 后必须同步这里的尾部字段（新字段一律追加在末尾）。
 */
const recognizerConfig = koffi.struct('SherpaRecognizerConfig', {
  feat_config: featureConfig,
  model_config: modelConfig,
  lm_config: lmConfig,
  decoding_method: C,
  max_active_paths: 'int32_t',
  hotwords_file: C,
  hotwords_score: 'float',
  rule_fsts: C,
  rule_fars: C,
  blank_penalty: 'float',
  hr: homophoneReplacerConfig,
  ctc_fst_decoder_config: ctcFstDecoderConfig
})

/* ------------------------------------------------------------------ *
 * TTS：结构体
 * ------------------------------------------------------------------ */

const vitsConfig = koffi.struct('SherpaVitsConfig', {
  model: C,
  lexicon: C,
  tokens: C,
  data_dir: C,
  noise_scale: 'float',
  noise_scale_w: 'float',
  length_scale: 'float',
  dict_dir: C
})

const matchaConfig = koffi.struct('SherpaMatchaConfig', {
  acoustic_model: C,
  vocoder: C,
  lexicon: C,
  tokens: C,
  data_dir: C,
  noise_scale: 'float',
  length_scale: 'float',
  dict_dir: C
})

const kokoroConfig = koffi.struct('SherpaKokoroConfig', {
  model: C,
  voices: C,
  tokens: C,
  data_dir: C,
  length_scale: 'float',
  dict_dir: C,
  lexicon: C,
  lang: C
})

const kittenConfig = koffi.struct('SherpaKittenConfig', {
  model: C,
  voices: C,
  tokens: C,
  data_dir: C,
  length_scale: 'float',
  // v2.0.1 新增（尾部），与 C 头文件逐字段对齐
  lexicon: C
})

const zipvoiceConfig = koffi.struct('SherpaZipvoiceConfig', {
  tokens: C,
  encoder: C,
  decoder: C,
  vocoder: C,
  data_dir: C,
  lexicon: C,
  feat_scale: 'float',
  t_shift: 'float',
  target_rms: 'float',
  guidance_scale: 'float'
})

const pocketConfig = koffi.struct('SherpaPocketConfig', {
  lm_flow: C,
  lm_main: C,
  encoder: C,
  decoder: C,
  text_conditioner: C,
  vocab_json: C,
  token_scores_json: C,
  voice_embedding_cache_capacity: 'int32_t'
})

const supertonicConfig = koffi.struct('SherpaSupertonicConfig', {
  duration_predictor: C,
  text_encoder: C,
  vector_estimator: C,
  vocoder: C,
  tts_json: C,
  unicode_indexer: C,
  voice_style: C
})

const ttsModelConfig = koffi.struct('SherpaTtsModelConfig', {
  vits: vitsConfig,
  num_threads: 'int32_t',
  debug: 'int32_t',
  provider: C,
  matcha: matchaConfig,
  kokoro: kokoroConfig,
  kitten: kittenConfig,
  zipvoice: zipvoiceConfig,
  pocket: pocketConfig,
  supertonic: supertonicConfig
})

const ttsConfig = koffi.struct('SherpaTtsConfig', {
  model: ttsModelConfig,
  rule_fsts: C,
  max_num_sentences: 'int32_t',
  rule_fars: C,
  silence_scale: 'float'
})

/** 合成结果（samples 指针由 C 侧持有，用完要 Destroy） */
const generatedAudio = koffi.struct('SherpaGeneratedAudio', {
  samples: koffi.pointer('float'),
  n: 'int32_t',
  sample_rate: 'int32_t'
})

/** 合成参数（推荐接口用；比 deprecated 的 sid/speed 版本多支持参考音频） */
const generationConfig = koffi.struct('SherpaGenerationConfig', {
  silence_scale: 'float',
  speed: 'float',
  sid: 'int32_t',
  reference_audio: koffi.pointer('float'),
  reference_audio_len: 'int32_t',
  reference_sample_rate: 'int32_t',
  reference_text: C,
  num_steps: 'int32_t',
  extra: C,
  /** v2.0.0 新增：预音素化输入（Unicode 码点）。本集成走 lexicon，恒为 null。 */
  phoneme_codepoints: koffi.pointer('int32_t'),
  phoneme_codepoints_lens: koffi.pointer('int32_t'),
  phoneme_codepoints_num_sentences: 'int32_t',
  /** v2.0.0 新增：预分词输入（如拼音）。本集成不使用，恒为 null。 */
  tokens: koffi.pointer(C),
  tokens_lens: koffi.pointer('int32_t'),
  tokens_num_sentences: 'int32_t'
})

/** 构造合成参数时的入参（参考音频是浮点采样，不是路径） */
export interface GenerationConfigInput {
  sid: number
  speed: number
  referenceAudio: Float32Array | null
  referenceSampleRate: number
  referenceText: string
}

/* ------------------------------------------------------------------ *
 * 函数绑定
 * ------------------------------------------------------------------ */

/** 不透明句柄（识别器 / 流 / TTS 实例 …） */
export type Handle = unknown

export interface SherpaAsrApi {
  create_recognizer: (config: unknown) => Handle
  destroy_recognizer: (recognizer: Handle) => void
  create_stream: (recognizer: Handle) => Handle
  destroy_stream: (stream: Handle) => void
  accept_waveform: (stream: Handle, sampleRate: number, samples: Float32Array, n: number) => void
  decode_stream: (recognizer: Handle, stream: Handle) => void
  /** 结果 JSON 字符串指针（用完必须 destroy_result_json） */
  get_result_json: (stream: Handle) => Handle
  destroy_result_json: (json: Handle) => void
}

export interface SherpaTtsApi {
  create_tts: (config: unknown) => Handle
  destroy_tts: (tts: Handle) => void
  /** 生成音频；返回 GeneratedAudio*（用完必须 destroy_generated_audio） */
  generate: (tts: Handle, text: string, sid: number, speed: number) => Handle
  /** 带合成参数的生成（支持参考音频/语音克隆） */
  generate_with_config: (tts: Handle, text: string, config: Handle) => Handle
  destroy_generated_audio: (audio: Handle) => void
}

export interface SherpaFfi {
  asr: SherpaAsrApi
  tts: SherpaTtsApi
  /** 读生成音频里的采样与采样率 */
  read_generated_audio: (audio: Handle) => { samples: Float32Array; sampleRate: number }
  /**
   * 构造合成参数结构体（返回已编码的指针）。
   *
   * 注意：参考音频的浮点缓冲由这里持有并随返回值一起传出去，
   * 调用方要保证它活到 generate_with_config 调用结束（返回对象里带 `keepAlive`）。
   */
  make_generation_config: (input: GenerationConfigInput) => { handle: Handle; keepAlive: unknown }
  /** 卸载动态库（进程退出时用） */
  unload(): void
}

/**
 * 加载 sherpa-onnx 运行时并完成 FFI 绑定。
 *
 * @param runtimeDir sherpa-onnx 运行时根目录（<libs>/sherpa-onnx，含 bin/ include/ lib/）
 */
export function loadSherpaFfi(runtimeDir: string): SherpaFfi {
  const libDir = join(runtimeDir, 'lib')
  const binDir = join(runtimeDir, 'bin')

  // 依赖 DLL（onnxruntime_providers_cuda.dll → cublas/cudnn…）靠 PATH 找
  const path = process.env.PATH ?? ''
  if (!path.includes(libDir)) {
    process.env.PATH = `${libDir}${delimiter}${binDir}${delimiter}${path}`
  }

  // 关键：先按绝对路径预加载同目录的 onnxruntime.dll。
  // 否则 Windows 的延迟加载会挑中机器上别处的旧版本（1.17.1 vs 随包的 1.27.1）。
  koffi.load(join(libDir, 'onnxruntime.dll'))

  const lib = koffi.load(join(libDir, 'sherpa-onnx-c-api.dll'))

  const asr: SherpaAsrApi = {
    create_recognizer: lib.func(
      'SherpaOnnxCreateOfflineRecognizer',
      voidPtr,
      [koffi.pointer(recognizerConfig)]
    ),
    destroy_recognizer: lib.func('SherpaOnnxDestroyOfflineRecognizer', 'void', [voidPtr]),
    create_stream: lib.func('SherpaOnnxCreateOfflineStream', voidPtr, [voidPtr]),
    destroy_stream: lib.func('SherpaOnnxDestroyOfflineStream', 'void', [voidPtr]),
    accept_waveform: lib.func('SherpaOnnxAcceptWaveformOffline', 'void', [
      voidPtr,
      'int32_t',
      'const float *',
      'int32_t'
    ]),
    decode_stream: lib.func('SherpaOnnxDecodeOfflineStream', 'void', [voidPtr, voidPtr]),
    get_result_json: lib.func('SherpaOnnxGetOfflineStreamResultAsJson', voidPtr, [voidPtr]),
    destroy_result_json: lib.func('SherpaOnnxDestroyOfflineStreamResultJson', 'void', [voidPtr])
  }

  const tts: SherpaTtsApi = {
    create_tts: lib.func('SherpaOnnxCreateOfflineTts', voidPtr, [koffi.pointer(ttsConfig)]),
    destroy_tts: lib.func('SherpaOnnxDestroyOfflineTts', 'void', [voidPtr]),
    generate: lib.func('SherpaOnnxOfflineTtsGenerate', voidPtr, [voidPtr, C, 'int32_t', 'float']),
    generate_with_config: lib.func('SherpaOnnxOfflineTtsGenerateWithConfig', voidPtr, [
      voidPtr,
      C,
      voidPtr
    ]),
    destroy_generated_audio: lib.func('SherpaOnnxDestroyOfflineTtsGeneratedAudio', 'void', [voidPtr])
  }

  return {
    asr,
    tts,
    read_generated_audio: (audio: Handle) => {
      // 注意：decode 传 count 会返回数组，这里要的是单个结构体
      const decoded = koffi.decode(audio, generatedAudio) as {
        samples: unknown
        n: number
        sample_rate: number
      }
      const n = decoded?.n ?? 0
      const samples = new Float32Array(n)
      if (n > 0 && decoded.samples) {
        // samples 是 C 侧指针，按长度拷贝出来
        const view = koffi.decode(decoded.samples, 'float', n)
        if (view instanceof Float32Array) samples.set(view)
      }
      return { samples, sampleRate: decoded?.sample_rate ?? 0 }
    },
    make_generation_config: (input: GenerationConfigInput) => {
      const referenceAudio = input.referenceAudio
      const audioBuf =
        referenceAudio && referenceAudio.length > 0 ? toFloatBuffer(referenceAudio) : null
      const buffer = koffi.alloc(generationConfig, 1)
      koffi.encode(buffer, 0, generationConfig, {
        silence_scale: 0.2,
        speed: input.speed,
        sid: input.sid,
        reference_audio: audioBuf,
        reference_audio_len: referenceAudio?.length ?? 0,
        reference_sample_rate: input.referenceSampleRate,
        reference_text: input.referenceText,
        num_steps: 0,
        extra: '',
        phoneme_codepoints: null,
        phoneme_codepoints_lens: null,
        phoneme_codepoints_num_sentences: 0,
        tokens: null,
        tokens_lens: null,
        tokens_num_sentences: 0
      })
      // keepAlive 必须由调用方持有到调用结束，否则浮点缓冲会被 GC，指针悬空
      return { handle: buffer, keepAlive: audioBuf }
    },
    unload: () => {
      /* DLL 随进程退出自动卸载，这里不做显式释放 */
    }
  }
}

/** Float32Array → koffi 可当 `float *` 传的缓冲 */
function toFloatBuffer(samples: Float32Array): Buffer {
  const buffer = Buffer.alloc(samples.length * 4)
  for (let i = 0; i < samples.length; i++) buffer.writeFloatLE(samples[i], i * 4)
  return buffer
}
