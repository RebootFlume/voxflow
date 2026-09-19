import type { TtsTask } from "../types";

/** 音色设置页的顶层模式（两个同级入口，选择随 tts 一起持久化） */
export type TtsVoiceMode = "preset" | "clone";

export interface TtsSlice {
  tts: {
    model: string;
    device: string;
    language: string;
    voice: string;
    /** 推理框架 = 运行时包 key（Rust payload 的 runtime_key，如 onnx）；接入新框架后由此切换 */
    framework: string;
    /** 音色设置页当前模式：内置预设音色 / 克隆音色（默认 preset） */
    voiceMode: TtsVoiceMode;
  };
  ttsModelStatus: "idle" | "loading" | "ready" | "error";
  ttsTasks: TtsTask[];
  /** 语音克隆状态 */
  ttsClone: {
    active: boolean;
    audioPath: string;
    referenceText: string;
    status: "idle" | "setting" | "ok" | "error";
    error: string;
  };
  updateTts: (patch: Partial<TtsSlice["tts"]>) => void;
  setTtsModelStatus: (s: TtsSlice["ttsModelStatus"]) => void;
  addTtsTask: (task: Omit<TtsTask, "id">) => number;
  updateTtsTask: (id: number, patch: Partial<TtsTask>) => void;
  removeTtsTask: (id: number) => void;
  updateTtsClone: (patch: Partial<TtsSlice["ttsClone"]>) => void;
}

export const createTtsSlice = (set: (partial: Partial<TtsSlice> | ((s: TtsSlice) => Partial<TtsSlice>)) => void): TtsSlice => ({
  tts: { model: "", device: "cpu", language: "zh", voice: "default", framework: "onnx", voiceMode: "preset" },
  ttsModelStatus: "idle",
  ttsTasks: [],
  ttsClone: { active: false, audioPath: "", referenceText: "", status: "idle", error: "" },
  updateTts: (patch) => set((s) => ({ tts: { ...s.tts, ...patch } })),
  setTtsModelStatus: (ttsModelStatus) => set({ ttsModelStatus }),
  updateTtsClone: (patch) => set((s) => ({ ttsClone: { ...s.ttsClone, ...patch } })),
  addTtsTask: (task) => {
    const id = Date.now();
    set((s) => ({ ttsTasks: [...s.ttsTasks, { ...task, id }] }));
    return id;
  },
  updateTtsTask: (id, patch) =>
    set((s) => ({
      ttsTasks: s.ttsTasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),
  removeTtsTask: (id) =>
    set((s) => ({ ttsTasks: s.ttsTasks.filter((t) => t.id !== id) })),
});
