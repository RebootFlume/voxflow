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

export type ModelFramework = "gguf" | "onnx";

/** 推理框架（按引擎区分，不再用 gguf/onnx 格式名） */
export type EngineFramework = "llama" | "sherpa" | "torch";

/** 引擎加载状态（集中管理：下载状态在 items[]，加载状态在这里） */
export interface EngineState {
  framework: EngineFramework | null;
  model: string | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
}

export interface ModelItemState {
  name: string;
  kind: "asr" | "tts";
  format: ModelFramework;
  repo: string;
  sizeGb: number;
  descriptionZh: string;
  descriptionEn: string;
  available: boolean;
  quant?: string;
  path: string;
  dirExists?: boolean;
  state: "not_downloaded" | "downloading" | "downloaded";
  modelPath?: string;
  mmprojPath?: string;
  percent?: number | null;
  file?: string | null;
  downloadedBytes?: number;
  totalBytes?: number | null;
  sizeOnDiskGb?: number;
  cancelRequested?: boolean;
}
