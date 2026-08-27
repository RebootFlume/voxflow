import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createUiSlice, type UiSlice } from "./slices/uiSlice";
import { createAsrSlice, type AsrSlice } from "./slices/asrSlice";
import { createTtsSlice, type TtsSlice } from "./slices/ttsSlice";
import { createApiSlice, type ApiSlice } from "./slices/apiSlice";
import { createModelsSlice, type ModelsSlice } from "./slices/modelsSlice";
import { createRuntimeSlice, type RuntimeSlice } from "./slices/runtimeSlice";
import { createSettingsSlice, type SettingsSlice } from "./slices/settingsSlice";
import { createInfrastructureSlice, type InfrastructureSlice } from "./slices/infrastructureSlice";

export type AppState = UiSlice & AsrSlice & TtsSlice & ApiSlice & ModelsSlice & RuntimeSlice & SettingsSlice & InfrastructureSlice;

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      ...createUiSlice(set),
      ...createAsrSlice(set),
      ...createTtsSlice(set),
      ...createApiSlice(set),
      ...createModelsSlice(set),
      ...createRuntimeSlice(set),
      ...createSettingsSlice(set),
      ...createInfrastructureSlice(set),
    }),
    {
      name: "voxflow-config",
      partialize: (state) => ({
        asr: { hotkey: state.asr.hotkey, model: state.asr.model, device: state.asr.device },
        tts: state.tts,
        api: { host: state.api.host, port: state.api.port, apiKey: state.api.apiKey },
        io: { exportDir: state.io.exportDir },
        overlay: state.overlay,
        theme: state.theme,
        locale: state.locale,
        models: { modelRoot: state.models.modelRoot, mirror: state.models.mirror, proxy: state.models.proxy },
        useRustEngine: state.useRustEngine,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...(typeof persisted === "object" && persisted !== null ? persisted : {}),
        asr: {
          ...current.asr,
          ...(typeof persisted === "object" && persisted !== null
            ? ((persisted as Record<string, unknown>).asr as Partial<typeof current.asr> | undefined)
            : {}),
          // 不再强制固定 ASR 模型：用户选择应持久化保留。
          // 仅当 persisted 里没有 model（首次启动）时用默认 0.6B。
          ...(typeof persisted === "object" &&
          persisted !== null &&
          (persisted as Record<string, unknown>).asr &&
          typeof ((persisted as Record<string, unknown>).asr as Record<string, unknown>).model === "string"
            ? {}
            : { model: "Qwen3-ASR-0.6B" }),
        },
        models: {
          ...current.models,
          ...(typeof persisted === "object" && persisted !== null
            ? ((persisted as Record<string, unknown>).models as Partial<typeof current.models> | undefined)
            : {}),
        },
      }),
    },
  ),
);

// Re-export shared pieces for backward compatibility
export { DEFAULT_SUB_MENUS } from "./slices/shared";
export type { Module, HistoryRecord, RuntimeLog, RuntimeLogLevel, TranscribeTask, TtsTask, ModelFramework, ModelItemState, EngineState } from "./types";
