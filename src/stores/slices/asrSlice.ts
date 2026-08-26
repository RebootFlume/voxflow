import type { ModelFramework, TranscribeTask } from "../types";

export interface AsrSlice {
  asr: {
    hotkey: string;
    model: string;
    device: string;
    framework: ModelFramework;
    modelStatus: "idle" | "loading" | "ready" | "error";
    status: "idle" | "recording" | "recognizing" | "done" | "error";
    volume: number;
  };
  transcribeTasks: TranscribeTask[];
  updateAsr: (patch: Partial<AsrSlice["asr"]>) => void;
  addTranscribeTask: (task: Omit<TranscribeTask, "id">) => number;
  updateTranscribeTask: (filePath: string, patch: Partial<TranscribeTask>) => void;
  removeTranscribeTask: (id: number) => void;
}

export const createAsrSlice = (set: (partial: Partial<AsrSlice> | ((s: AsrSlice) => Partial<AsrSlice>)) => void): AsrSlice => ({
  asr: { hotkey: "CapsLock", model: "Qwen3-ASR-0.6B", device: "cpu", framework: "gguf", modelStatus: "idle", status: "idle", volume: 0 },
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
