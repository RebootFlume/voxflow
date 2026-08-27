import type { EngineState, ModelFramework, ModelItemState } from "../types";

/** 引擎集中管理：每个功能（asr/tts）一个引擎状态 */
export interface EngineRegistry {
  asr: EngineState;
  tts: EngineState;
}

function idleEngine(): EngineState {
  return { framework: null, model: null, status: "idle", stage: null, error: null };
}

export interface ModelsSlice {
  /** 启动阶段：booting = 显示启动 Splash，ready = 主界面 */
  startupPhase: "booting" | "ready";
  models: {
    modelRoot: string;
    mirror: string;
    proxy: string;
    diskFreeGb: number | null;
    items: ModelItemState[];
    loadedModel: string | null;
    loadedDevice: string | null;
  };
  /** 引擎加载状态（集中管理） */
  engines: EngineRegistry;
  setModelRootLocal: (p: string) => void;
  setMirror: (m: string) => void;
  setProxyLocal: (p: string) => void;
  applyModelsState: (payload: Record<string, unknown>) => void;
  applyDownloadProgress: (payload: Record<string, unknown>) => void;
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
  models: { modelRoot: "", mirror: "", proxy: "", diskFreeGb: null, items: [], loadedModel: null, loadedDevice: null },
  engines: { asr: idleEngine(), tts: idleEngine() },
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
            cpu: (m.cpu === "slow" || m.cpu === "unsupported" ? m.cpu : "good") as ModelItemState["cpu"],
            quant: typeof m.quant === "string" ? m.quant : undefined,
            path: String(m.path ?? ""),
            dirExists: m.dir_exists === true,
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
