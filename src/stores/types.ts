export type Module = "asr" | "tts" | "api" | "history" | "models" | "settings";

export interface HistoryRecord {
  id: number;
  text: string;
  time: string;
}

export type RuntimeLogLevel = "info" | "warn" | "error" | "success";
export interface RuntimeLog {
  id: number;
  ts: string;
  level: RuntimeLogLevel;
  msg: string;
}

export interface TranscribeTask {
  id: number;
  fileName: string;
  filePath: string;
  status: "pending" | "transcribing" | "done" | "error";
  progress?: number;
  doneSec?: number;
  totalSec?: number;
  result?: string;
  savedPath?: string;
  error?: string;
}

export interface TtsTask {
  id: number;
  text: string;
  voice: string;
  status: "pending" | "synthesizing" | "done" | "error";
  savedPath?: string;
  fileSize?: string;
  error?: string;
}

/** 运行时包 key（Rust models_state 下发的 runtime_key / 既有 format 同域；前端不再枚举） */
export type ModelFramework = string;

/** 推理框架展示名（引擎 id，Rust 下发；前端不再枚举） */
export type EngineFramework = string;

/** 引擎加载状态（集中管理：下载状态在 items[]，加载状态在这里） */
export interface EngineState {
  framework: EngineFramework | null;
  model: string | null;
  status: "idle" | "loading" | "ready" | "error";
  /** 加载阶段（loading 时的细分进度）：unload（卸载旧模型）→ loading（启动/等待）→ ready */
  stage: "unload" | "loading" | "ready" | null;
  error: string | null;
}

export interface ModelItemState {
  name: string;
  kind: "asr" | "tts";
  /** 既有格式字段（= runtime_key，历史消费方兼容） */
  format: ModelFramework;
  /** 引擎展示名（llama / sherpa / torch …，Rust 下发；用于分组/标签/配色） */
  engine?: string;
  /** 运行时包 key（gguf / onnx …，Rust 下发；用于运行门禁与包查询；缺省回退 format） */
  runtime_key?: string;
  /** 来源标签（如 github.com/k2-fsa/sherpa-onnx、huggingface.co/…，Rust 推导；前端只展示） */
  source: string;
  sizeGb: number;
  descriptionZh: string;
  descriptionEn: string;
  available: boolean;
  /** CPU 模式体验分级：good（可用）/ slow（能跑但慢）/ unsupported（不支持 CPU） */
  cpu?: "good" | "slow" | "unsupported";
  quant?: string;
  path: string;
  dirExists?: boolean;
  state: "not_downloaded" | "downloading" | "downloaded";
  modelPath?: string;
  mmprojPath?: string;
  percent?: number | null;
  file?: string | null;
  /** 下载完成、解压中（GitHub tar 包阶段；无百分比，UI 显示"正在解压"） */
  extracting?: boolean;
  downloadedBytes?: number;
  totalBytes?: number | null;
  sizeOnDiskGb?: number;
  cancelRequested?: boolean;
  // ── 能力字段（描述符驱动，models_state 事件携带；TTS 语言/克隆 UI 据此渲染）──
  languages?: string[];
  language_mode?: "auto" | "fixed" | "select" | "cloning";
  voice_mode?: {
    type: "fixed" | "preset" | "clone" | "preset_and_clone";
    count?: number;
    per_language?: boolean;
    requires_text?: boolean;
    overrides_preset?: boolean;
  };
  supports_clone?: boolean;
}
