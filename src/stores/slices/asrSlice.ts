import type { ModelFramework, TranscribeTask } from "../types";

export interface AsrSlice {
  asr: {
    hotkey: string;
    model: string;
    device: string;
    framework: ModelFramework;
    modelStatus: "idle" | "loading" | "ready" | "error";
    /** 最近一次加载请求号：事件按它丢弃旧请求的迟到终态 */
    loadReqId: number;
    status: "idle" | "recording" | "recognizing" | "done" | "error";
    volume: number;
    /** 启动软件时自动加载"上次真正加载过"的模型（默认开：热键要求常驻） */
    autoLoad: boolean;
    /** 每个框架各自记住上次选中的模型：切框架只恢复这个，不替用户挑第一个 */
    lastModelByFramework: Record<string, string>;
  };
  transcribeTasks: TranscribeTask[];
  updateAsr: (patch: Partial<AsrSlice["asr"]>) => void;
  addTranscribeTask: (task: Omit<TranscribeTask, "id">) => number;
  updateTranscribeTask: (filePath: string, patch: Partial<TranscribeTask>) => void;
  removeTranscribeTask: (id: number) => void;
}

export const createAsrSlice = (set: (partial: Partial<AsrSlice> | ((s: AsrSlice) => Partial<AsrSlice>)) => void): AsrSlice => ({
  asr: {
    hotkey: "CapsLock",
    model: "Qwen3-ASR-0.6B",
    device: "cpu",
    framework: "gguf",
    modelStatus: "idle",
    loadReqId: 0,
    status: "idle",
    volume: 0,
    autoLoad: true,
    lastModelByFramework: {},
  },
  transcribeTasks: [],
  updateAsr: (patch) => set((s) => ({ asr: { ...s.asr, ...patch } })),
  addTranscribeTask: (task) => {
    const id = Date.now();
    set((s) => ({ transcribeTasks: [...s.transcribeTasks, { ...task, id }] }));
    return id;
  },
  updateTranscribeTask: (filePath, patch) =>
    set((s) => ({
      transcribeTasks: s.transcribeTasks.map((t) => (t.filePath === filePath ? { ...t, ...patch } : t)),
    })),
  removeTranscribeTask: (id) =>
    set((s) => ({ transcribeTasks: s.transcribeTasks.filter((t) => t.id !== id) })),
});
