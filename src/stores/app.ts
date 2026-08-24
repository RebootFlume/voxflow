import { create } from "zustand";

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
  rate: number;
  status: "pending" | "synthesizing" | "done" | "error";
  duration?: number;
  savedPath?: string;
  fileSize?: string;
  error?: string;
}

export type ModelFramework = "gguf" | "onnx";

export interface ModelItemState {
  name: string;
  kind: "asr" | "tts";
  format: ModelFramework;
  repo: string;
  sizeGb: number;
  descriptionZh: string;
  descriptionEn: string;
  available: boolean;
  path: string;
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

export interface AppState {
  activeModule: Module;
  activeSubMenu: string;

  asr: {
    hotkey: string;
    model: string;
    device: string;
    framework: ModelFramework;
    modelStatus: "idle" | "loading" | "ready" | "error";
    status: "idle" | "recording" | "recognizing" | "done" | "error";
    volume: number;
  };

  tts: {
    model: string;
    device: string;
    language: string;
    voice: string;
    rate: number;
    volume: number;
    hotkey: string;
  };

  api: {
    enabled: boolean;
    host: string;
    port: number;
    apiKey: string;
    endpoints: { asr: boolean; tts: boolean };
  };

  transcribe: {
    format: string;
  };

  /** 共享 IO 配置：ASR 转写与 TTS 合成共用的导出目录 */
  io: {
    exportDir: string;
  };

  audioDevices: {
    current: string;
    currentName: string;
  };

  gpu: {
    available: boolean;
    name: string;
    deviceCount: number;
  };

  capabilities: {
    ffmpeg: boolean;
  };

  models: {
    modelRoot: string;
    mirror: string;
    proxy: string;
    diskFreeGb: number | null;
    items: ModelItemState[];
    loadedModel: string | null;
    loadedDevice: string | null;
  };

  overlay: { visible: boolean };
  theme: { mode: "system" | "light" | "dark"; accent: string };
  runtimeLogs: RuntimeLog[];
  history: { records: HistoryRecord[] };
  transcribeTasks: TranscribeTask[];
  ttsTasks: TtsTask[];
  ttsModelStatus: "idle" | "loading" | "ready" | "error";
  useRustEngine: boolean;
  sidebarCollapsed: boolean;
  locale: "zh" | "en";

  // ---- actions ----
  setActiveModule: (m: Module) => void;
  setActiveSubMenu: (s: string) => void;
  updateAsr: (patch: Partial<AppState["asr"]>) => void;
  updateTts: (patch: Partial<AppState["tts"]>) => void;
  updateTranscribe: (patch: Partial<AppState["transcribe"]>) => void;
  updateIo: (patch: Partial<AppState["io"]>) => void;
  updateApi: (patch: Partial<AppState["api"]>) => void;
  updateOverlay: (patch: Partial<AppState["overlay"]>) => void;
  toggleApi: (on: boolean) => void;
  updateTheme: (patch: Partial<AppState["theme"]>) => void;
  setThemeMode: (mode: AppState["theme"]["mode"]) => void;
  setAccent: (hex: string) => void;
  setModelRootLocal: (p: string) => void;
  setMirror: (m: string) => void;
  setProxyLocal: (p: string) => void;
  applyModelsState: (payload: Record<string, unknown>) => void;
  applyDownloadProgress: (payload: Record<string, unknown>) => void;
  applyDownloadDone: (status: string, model: string) => void;
  setLoadedModel: (model: string, device: string) => void;
  setAudioDevices: (current: string, currentName: string) => void;
  setGpu: (available: boolean, name: string, deviceCount: number) => void;
  setCapabilities: (patch: Partial<AppState["capabilities"]>) => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;
  setLocale: (l: "zh" | "en") => void;
  addLog: (msg: string, level?: RuntimeLogLevel) => void;
  clearLogs: () => void;
  addHistoryRecord: (text: string) => void;
  removeHistoryRecord: (id: number) => void;
  addTranscribeTask: (task: Omit<TranscribeTask, "id">) => number;
  updateTranscribeTask: (filePath: string, patch: Partial<TranscribeTask>) => void;
  removeTranscribeTask: (id: number) => void;
  addTtsTask: (task: Omit<TtsTask, "id">) => number;
  updateTtsTask: (id: number, patch: Partial<TtsTask>) => void;
  removeTtsTask: (id: number) => void;
  setTtsModelStatus: (s: AppState["ttsModelStatus"]) => void;
  setUseRustEngine: (v: boolean) => void;
}

export const DEFAULT_SUB_MENUS: Record<Module, string[]> = {
  asr: ["hotkey", "model", "transcribe", "status"],
  tts: ["model-device", "voice-settings", "synthesize"],
  api: ["service", "endpoint-status", "console"],
  history: ["records", "runtime"],
  models: ["settings", "asr", "tts"],
  settings: ["general", "appearance", "about"],
};

let NEXT_LOG_ID = 1;
function nowTs(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export const useAppStore = create<AppState>((set) => ({
  activeModule: "asr",
  activeSubMenu: "hotkey",

  asr: { hotkey: "CapsLock", model: "Qwen3-ASR-0.6B", device: "cpu", framework: "gguf" as ModelFramework, modelStatus: "idle", status: "idle", volume: 0 },
  tts: { model: "Kokoro-82M", device: "cpu", language: "zh", voice: "default", rate: 1.0, volume: 1.0, hotkey: "Alt+Shift+S" },
  api: { enabled: false, host: "127.0.0.1", port: 9870, apiKey: "", endpoints: { asr: false, tts: false } },
  transcribe: { format: "txt" },
  io: { exportDir: "" },
  audioDevices: { current: "default", currentName: "…" },
  gpu: { available: false, name: "", deviceCount: 0 },
  capabilities: { ffmpeg: false },
  models: { modelRoot: "", mirror: "", proxy: "", diskFreeGb: null, items: [], loadedModel: null, loadedDevice: null },
  overlay: { visible: true },
  theme: { mode: "system", accent: "#18181b" },
  runtimeLogs: [],
  history: { records: [] },
  transcribeTasks: [],
  ttsTasks: [],
  ttsModelStatus: "idle" as const,
  useRustEngine: true,
  sidebarCollapsed: false,
  locale: "zh",

  setActiveModule: (m) => set((s) => ({ activeModule: m, activeSubMenu: s.activeModule === m ? s.activeSubMenu : DEFAULT_SUB_MENUS[m][0] })),
  setActiveSubMenu: (sub) => set({ activeSubMenu: sub }),

  addHistoryRecord: (text) =>
    set((s) => ({
      history: { ...s.history, records: [...s.history.records, { id: Date.now(), text, time: new Date().toLocaleString() }].slice(-500) },
    })),
  removeHistoryRecord: (id) =>
    set((s) => ({ history: { ...s.history, records: s.history.records.filter((r) => r.id !== id) } })),

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
  setTtsModelStatus: (ttsModelStatus) => set({ ttsModelStatus }),
  setUseRustEngine: (useRustEngine) => set({ useRustEngine }),

  setModelRootLocal: (modelRoot) => set((s) => ({ models: { ...s.models, modelRoot } })),
  setMirror: (mirror) => set((s) => ({ models: { ...s.models, mirror } })),
  setProxyLocal: (proxy) => set((s) => ({ models: { ...s.models, proxy } })),

  applyModelsState: (payload) => {
    const items = Array.isArray(payload.models) ? payload.models : [];
    set((s) => ({
      models: {
        ...s.models,
        modelRoot: typeof payload.model_root === "string" ? payload.model_root : s.models.modelRoot,
        diskFreeGb: typeof payload.disk_free_gb === "number" ? payload.disk_free_gb : s.models.diskFreeGb,
        mirror: typeof payload.mirror === "string" ? payload.mirror : s.models.mirror,
        proxy: typeof payload.proxy === "string" ? payload.proxy : s.models.proxy,
        items: items.map((m: Record<string, unknown>) => {
          const prev = s.models.items.find((it) => it.name === m.name);
          return {
            name: String(m.name ?? ""),
            kind: (m.kind === "tts" ? "tts" : "asr") as ModelItemState["kind"],
            format: ((m.format === "onnx" ? "onnx" : "gguf") as ModelFramework),
            repo: String(m.repo ?? ""),
            sizeGb: Number(m.size_gb ?? 0),
            descriptionZh: String(m.description_zh ?? ""),
            descriptionEn: String(m.description_en ?? ""),
            available: m.available !== false,
            path: String(m.path ?? ""),
            state: (m.state as ModelItemState["state"]) ?? "not_downloaded",
            modelPath: typeof m.model_path === "string" ? m.model_path : undefined,
            mmprojPath: typeof m.mmproj_path === "string" ? m.mmproj_path : undefined,
            percent: prev?.percent ?? null,
            file: prev?.file ?? null,
            downloadedBytes: prev?.downloadedBytes,
            totalBytes: prev?.totalBytes ?? null,
            sizeOnDiskGb: typeof m.size_on_disk_gb === "number" ? m.size_on_disk_gb : undefined,
            cancelRequested: prev?.cancelRequested ?? false,
          } satisfies ModelItemState;
        }),
      },
    }));
  },

  applyDownloadProgress: (payload) => {
    const name = String(payload.model ?? "");
    set((s) => ({
      models: { ...s.models, items: s.models.items.map((it) => it.name === name ? { ...it, state: "downloading" as const, percent: typeof payload.percent === "number" ? payload.percent : it.percent, file: typeof payload.file === "string" ? payload.file : it.file, downloadedBytes: typeof payload.downloaded_bytes === "number" ? payload.downloaded_bytes : it.downloadedBytes, totalBytes: typeof payload.total_bytes === "number" ? payload.total_bytes : it.totalBytes } : it) },
    }));
  },

  applyDownloadDone: (status, model) => {
    const cancelled = status !== "model_downloaded";
    set((s) => ({
      models: { ...s.models, items: s.models.items.map((it) => it.name === model ? { ...it, state: cancelled && status === "model_download_cancelled" ? ("not_downloaded" as const) : it.state, cancelRequested: cancelled } : it) },
    }));
  },

  setLoadedModel: (loadedModel, loadedDevice) => set((s) => ({ models: { ...s.models, loadedModel, loadedDevice } })),
  setAudioDevices: (current, currentName) => set({ audioDevices: { current, currentName } }),
  setGpu: (available, name, deviceCount) => set({ gpu: { available, name, deviceCount } }),
  setCapabilities: (patch) => set((s) => ({ capabilities: { ...s.capabilities, ...patch } })),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setLocale: (locale) => set({ locale }),

  addLog: (msg, level = "info") =>
    set((s) => {
      const next = [...s.runtimeLogs, { id: NEXT_LOG_ID++, ts: nowTs(), level, msg }];
      return { runtimeLogs: next.length > 300 ? next.slice(-300) : next };
    }),
  clearLogs: () => set({ runtimeLogs: [] }),

  updateTheme: (patch) => set((s) => ({ theme: { ...s.theme, ...patch } })),
  setThemeMode: (mode) => set((s) => ({ theme: { ...s.theme, mode } })),
  setAccent: (accent) => set((s) => ({ theme: { ...s.theme, accent } })),
  updateAsr: (patch) => set((s) => ({ asr: { ...s.asr, ...patch } })),
  updateTts: (patch) => set((s) => ({ tts: { ...s.tts, ...patch } })),
  updateTranscribe: (patch) => set((s) => ({ transcribe: { ...s.transcribe, ...patch } })),
  updateIo: (patch) => set((s) => ({ io: { ...s.io, ...patch } })),
  updateApi: (patch) => set((s) => ({ api: { ...s.api, ...patch } })),
  updateOverlay: (patch) => set((s) => ({ overlay: { ...s.overlay, ...patch } })),
  toggleApi: (on) => set((s) => ({ api: { ...s.api, enabled: on, endpoints: { asr: on, tts: on } } })),
}));
