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
    /** 自然语言音色描述（audio.cpp instruct；空串 = 不用）。随 tts 持久化 */
    instruct: string;
    /** 启动软件时自动加载上次加载过的模型（默认关：TTS 是按需服务，不占开机内存/显存） */
    autoLoad: boolean;
    /** 每个框架各自记住上次选中的模型：切框架只恢复这个，不替用户挑第一个 */
    lastModelByFramework: Record<string, string>;
  };
  ttsModelStatus: "idle" | "loading" | "ready" | "error";
  ttsTasks: TtsTask[];
  /** 语音克隆状态 */
  ttsClone: {
    active: boolean;
    /** 生效中的音色库条目 id（空 = 未激活）。合成页的「音色」下拉用它表达"当前选的是哪条克隆"。 */
    id: string;
    /** 生效中的克隆音色名（音色库里的 name）；展示用，空 = 名字未知。
     *  整个 `ttsClone` 都是**运行态**：不进 config.json，权威与选中项在
     *  `tts-voices/voices.json`（模型就绪时按 `active_id` 恢复）。 */
    name: string;
    audioPath: string;
    referenceText: string;
    status: "idle" | "setting" | "ok" | "error";
    error: string;
  };
  /**
   * 合成输入（运行态，不持久化）。
   *
   * 为什么放在 store 而不是 SynthesizePage 的 useState：TtsPanel 按子页面条件渲染，
   * 切到「模型与设备」再回来组件会卸载 → 刚导入的 60 万字文本直接消失。
   * 用户的实际动线就是「先导入文件 → 去加载模型 → 回来合成」，中间必然切页。
   */
  ttsInput: {
    /** 输入源（二选一）：直接输入文本 / 导入的文本文件 */
    source: "text" | "file";
    /** 直接输入的文本 */
    text: string;
    /** 已导入的文件（null = 未导入）。`body` 是解码后的全文 */
    file: { path: string; name: string; chars: number; encoding: string; body: string } | null;
  };
  updateTtsInput: (patch: Partial<TtsSlice["ttsInput"]>) => void;
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
  tts: {
    model: "",
    device: "cpu",
    language: "zh",
    voice: "",
    framework: "onnx",
    voiceMode: "preset",
    instruct: "",
    autoLoad: false,
    lastModelByFramework: {},
  },
  ttsModelStatus: "idle",
  ttsTasks: [],
  ttsInput: { source: "text", text: "", file: null },
  updateTtsInput: (patch) => set((s) => ({ ttsInput: { ...s.ttsInput, ...patch } })),
  ttsClone: { active: false, id: "", name: "", audioPath: "", referenceText: "", status: "idle", error: "" },
  updateTts: (patch) => set((s) => ({ tts: { ...s.tts, ...patch } })),
  setTtsModelStatus: (ttsModelStatus) => set({ ttsModelStatus }),
  updateTtsClone: (patch) => set((s) => ({ ttsClone: { ...s.ttsClone, ...patch } })),
  resetTtsClone: () =>
    set({
      ttsClone: { active: false, id: "", name: "", audioPath: "", referenceText: "", status: "idle", error: "" },
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
