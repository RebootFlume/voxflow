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
    /** 生效中的克隆音色名（音色库里的 name）；展示用，空 = 名字未知。
     *  整个 `ttsClone` 都是**运行态**：不进 config.json，权威与选中项在
     *  `tts-voices/voices.json`（模型就绪时按 `active_id` 恢复）。 */
    name: string;
    audioPath: string;
    referenceText: string;
    status: "idle" | "setting" | "ok" | "error";
    error: string;
  };
  updateTts: (patch: Partial<TtsSlice["tts"]>) => void;
  setTtsModelStatus: (s: TtsSlice["ttsModelStatus"]) => void;
  addTtsTask: (task: Omit<TtsTask, "id">) => number;
  updateTtsTask: (id: number, patch: Partial<TtsTask>) => void;
  /** 把补丁写到当前处于 synthesizing 的任务（串行队列下最多一个；没有则不动 = 忽略迟到事件） */
  updateSynthesizingTask: (patch: Partial<TtsTask>) => void;
  removeTtsTask: (id: number) => void;
  updateTtsClone: (patch: Partial<TtsSlice["ttsClone"]>) => void;
  /** 停用克隆音色：active=false 的同时**清掉 name/audioPath/referenceText**。
   *  不变量：不激活 ⇒ 不留上一份克隆的痕迹（否则"停用了却还记着名字"会误导后续读取方）。 */
  resetTtsClone: () => void;
}

export const createTtsSlice = (set: (partial: Partial<TtsSlice> | ((s: TtsSlice) => Partial<TtsSlice>)) => void): TtsSlice => ({
  tts: { model: "", device: "cpu", language: "zh", voice: "", framework: "onnx", voiceMode: "preset" },
  ttsModelStatus: "idle",
  ttsTasks: [],
  ttsClone: { active: false, name: "", audioPath: "", referenceText: "", status: "idle", error: "" },
  updateTts: (patch) => set((s) => ({ tts: { ...s.tts, ...patch } })),
  setTtsModelStatus: (ttsModelStatus) => set({ ttsModelStatus }),
  updateTtsClone: (patch) => set((s) => ({ ttsClone: { ...s.ttsClone, ...patch } })),
  resetTtsClone: () =>
    set({
      ttsClone: { active: false, name: "", audioPath: "", referenceText: "", status: "idle", error: "" },
    }),
  addTtsTask: (task) => {
    const id = Date.now();
    set((s) => ({ ttsTasks: [...s.ttsTasks, { ...task, id }] }));
    return id;
  },
  updateTtsTask: (id, patch) =>
    set((s) => ({
      ttsTasks: s.ttsTasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),
  // tts_progress 事件只带分段数字、不带任务 id（Rust 只跑一个合成）⇒ 按状态定位唯一的目标任务
  updateSynthesizingTask: (patch) =>
    set((s) => ({
      ttsTasks: s.ttsTasks.map((t) => (t.status === "synthesizing" ? { ...t, ...patch } : t)),
    })),
  removeTtsTask: (id) =>
    set((s) => ({ ttsTasks: s.ttsTasks.filter((t) => t.id !== id) })),
});
