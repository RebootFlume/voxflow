import type { TtsTask } from "../types";

export interface TtsSlice {
  tts: {
    model: string;
    device: string;
    language: string;
    voice: string;
    volume: number;
    hotkey: string;
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
  tts: { model: "", device: "cpu", language: "zh", voice: "default", volume: 1.0, hotkey: "Alt+Shift+S" },
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
