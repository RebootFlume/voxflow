import type { EngineState, ModelEntryState, ModelItemState } from "../types";

/** 引擎集中管理：每个功能（asr/tts）一个引擎状态 */
export interface EngineRegistry {
  asr: EngineState;
  tts: EngineState;
}

function idleEngine(): EngineState {
  return { framework: null, model: null, status: "idle", stage: null, error: null };
}

// ── 能力字段归一化（models_state 事件 → ModelItemState）──
// 形状不合法 / 缺失一律保持 undefined：不塞默认值，避免掩盖上游缺字段（UI 侧各自兜底）。
const LANGUAGE_MODES: NonNullable<ModelItemState["language_mode"]>[] = ["auto", "fixed", "select", "cloning"];
const VOICE_MODES: NonNullable<ModelItemState["voice_mode"]>["type"][] = ["fixed", "preset", "clone", "preset_and_clone"];

/** voice_mode 是对象：仅接受合法 type，浅拷 5 个字段（type + 4 个可选） */
function pickVoiceMode(v: unknown): ModelItemState["voice_mode"] {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const type = o.type as NonNullable<ModelItemState["voice_mode"]>["type"];
  if (!VOICE_MODES.includes(type)) return undefined;
  return {
    type,
    count: typeof o.count === "number" ? o.count : undefined,
    per_language: typeof o.per_language === "boolean" ? o.per_language : undefined,
    requires_text: typeof o.requires_text === "boolean" ? o.requires_text : undefined,
    overrides_preset: typeof o.overrides_preset === "boolean" ? o.overrides_preset : undefined,
  };
}

/** 精选条目数组：非数组 → []；逐项字符串/数值兜底，state 缺失回退 not_downloaded */
function pickEntries(v: unknown): ModelEntryState[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e) => ({
      id: String(e.id ?? ""),
      labelZh: String(e.label_zh ?? ""),
      labelEn: String(e.label_en ?? ""),
      sizeGb: Number(e.size_gb ?? 0) || 0,
      vramEstimateMb: typeof e.vram_estimate_mb === "number" ? e.vram_estimate_mb : undefined,
      default: e.default === true,
      state: (e.state as ModelEntryState["state"]) ?? "not_downloaded",
    }));
}

export interface ModelsSlice {
  /** 启动阶段：booting = 显示启动 Splash，ready = 主界面 */
  startupPhase: "booting" | "ready";
  models: {
    modelRoot: string;
    proxy: string;
    /** Hugging Face 下载 token（config.json 持久化；无 UI，用户手改文件） */
    huggingfaceToken: string;
    hasHfToken: boolean;
    diskFreeGb: number | null;
    items: ModelItemState[];
    loadedModel: string | null;
    loadedDevice: string | null;
  };
  /** 引擎加载状态（集中管理） */
  engines: EngineRegistry;
  setModelRootLocal: (p: string) => void;
  setProxyLocal: (p: string) => void;
  setHfTokenLocal: (t: string) => void;
  applyModelsState: (payload: Record<string, unknown>) => void;
  applyDownloadProgress: (payload: Record<string, unknown>) => void;
  applyDownloadExtracting: (name: string) => void;
  applyDownloadDone: (status: string, model: string) => void;
  setLoadedModel: (model: string, device: string) => void;
  /** 引擎操作 */
  setEngineStatus: (kind: "asr" | "tts", patch: Partial<EngineState>) => void;
  resetEngine: (kind: "asr" | "tts") => void;
  /** 启动阶段控制 */
  setStartupPhase: (phase: "booting" | "ready") => void;
}

export const createModelsSlice = (set: (partial: Partial<ModelsSlice> | ((s: ModelsSlice) => Partial<ModelsSlice>)) => void): ModelsSlice => ({
  startupPhase: "booting",
  models: { modelRoot: "", proxy: "", huggingfaceToken: "", hasHfToken: false, diskFreeGb: null, items: [], loadedModel: null, loadedDevice: null },
  engines: { asr: idleEngine(), tts: idleEngine() },
  setModelRootLocal: (modelRoot) => set((s) => ({ models: { ...s.models, modelRoot } })),
  setProxyLocal: (proxy) => set((s) => ({ models: { ...s.models, proxy } })),
  setHfTokenLocal: (huggingfaceToken) =>
    set((s) => ({ models: { ...s.models, huggingfaceToken, hasHfToken: huggingfaceToken.trim() !== "" } })),

  applyModelsState: (payload) => {
    const items = Array.isArray(payload.models) ? payload.models : [];
    set((s) => ({
      models: {
        ...s.models,
        modelRoot: typeof payload.model_root === "string" ? payload.model_root : s.models.modelRoot,
        diskFreeGb: typeof payload.disk_free_gb === "number" ? payload.disk_free_gb : s.models.diskFreeGb,
        proxy: typeof payload.proxy === "string" ? payload.proxy : s.models.proxy,
        items: items.map((m: Record<string, unknown>) => {
          const prev = s.models.items.find((it) => it.name === m.name);
          return {
            name: String(m.name ?? ""),
            kind: (m.kind === "tts" ? "tts" : "asr") as ModelItemState["kind"],
            // format / engine / runtime_key 全部透传 Rust 原值（非法/缺失保持空值，不塞默认）
            format: typeof m.format === "string" ? m.format : "",
            engine: typeof m.engine === "string" ? m.engine : undefined,
            runtime_key: typeof m.runtime_key === "string" ? m.runtime_key : undefined,
            source: String(m.source ?? ""),
            sizeGb: Number(m.size_gb ?? 0),
            vramEstimateMb: typeof m.vram_estimate_mb === "number" ? m.vram_estimate_mb : undefined,
            descriptionZh: String(m.description_zh ?? ""),
            descriptionEn: String(m.description_en ?? ""),
            available: m.available !== false,
            cpu: (m.cpu === "slow" || m.cpu === "unsupported" ? m.cpu : "good") as ModelItemState["cpu"],
            quant: typeof m.quant === "string" ? m.quant : undefined,
            path: String(m.path ?? ""),
            dirExists: m.dir_exists === true,
            // 精选条目：缺失 → []；active_entry 缺失/空串 → null（无安装或无条目）
            entries: pickEntries(m.entries),
            activeEntry:
              typeof m.active_entry === "string" && m.active_entry !== "" ? m.active_entry : null,
            state: (m.state as ModelItemState["state"]) ?? "not_downloaded",
            modelPath: typeof m.model_path === "string" ? m.model_path : undefined,
            mmprojPath: typeof m.mmproj_path === "string" ? m.mmproj_path : undefined,
            percent: prev?.percent ?? null,
            file: prev?.file ?? null,
            downloadedBytes: prev?.downloadedBytes,
            totalBytes: prev?.totalBytes ?? null,
            sizeOnDiskGb: typeof m.size_on_disk_gb === "number" ? m.size_on_disk_gb : undefined,
            cancelRequested: prev?.cancelRequested ?? false,
            // 能力字段（描述符驱动）：原样透传，缺失/非法保持 undefined
            languages: Array.isArray(m.languages) ? (m.languages as string[]) : undefined,
            language_mode: LANGUAGE_MODES.includes(m.language_mode as NonNullable<ModelItemState["language_mode"]>)
              ? (m.language_mode as ModelItemState["language_mode"])
              : undefined,
            voice_mode: pickVoiceMode(m.voice_mode),
            supports_clone: typeof m.supports_clone === "boolean" ? m.supports_clone : undefined,
          } satisfies ModelItemState;
        }),
      },
    }));
  },

  applyDownloadProgress: (payload) => {
    const name = String(payload.model ?? "");
    set((s) => ({
      models: {
        ...s.models,
        items: s.models.items.map((it) =>
          it.name === name
            ? {
                ...it,
                state: "downloading" as const,
                percent: typeof payload.percent === "number" ? payload.percent : it.percent,
                file: typeof payload.file === "string" ? payload.file : it.file,
                downloadedBytes: typeof payload.downloaded_bytes === "number" ? payload.downloaded_bytes : it.downloadedBytes,
                totalBytes: typeof payload.total_bytes === "number" ? payload.total_bytes : it.totalBytes,
              }
            : it,
        ),
      },
    }));
  },

  applyDownloadExtracting: (name) => {
    set((s) => ({
      models: {
        ...s.models,
        items: s.models.items.map((it) =>
          it.name === name
            ? { ...it, state: "downloading" as const, percent: 100, extracting: true }
            : it,
        ),
      },
    }));
  },

  applyDownloadDone: (status, model) => {
    const ok = status === "model_downloaded";
    set((s) => ({
      models: {
        ...s.models,
        items: s.models.items.map((it) =>
          it.name === model
            ? {
                ...it,
                // 下载成功 → 直接标记 downloaded（不再等下次轮询扫描磁盘）；取消 → 回 not_downloaded
                state: ok
                  ? ("downloaded" as const)
                  : status === "model_download_cancelled"
                    ? ("not_downloaded" as const)
                    : it.state,
                extracting: false,
                cancelRequested: !ok,
              }
            : it,
        ),
      },
    }));
  },

  setLoadedModel: (loadedModel, loadedDevice) =>
    set((s) => ({ models: { ...s.models, loadedModel, loadedDevice } })),

  setEngineStatus: (kind, patch) =>
    set((s) => ({ engines: { ...s.engines, [kind]: { ...s.engines[kind], ...patch } } })),
  resetEngine: (kind) =>
    set((s) => ({ engines: { ...s.engines, [kind]: idleEngine() } })),
  setStartupPhase: (startupPhase) => set({ startupPhase }),
});
