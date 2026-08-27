import { create } from "zustand";
import { createUiSlice, type UiSlice } from "./slices/uiSlice";
import { createAsrSlice, type AsrSlice } from "./slices/asrSlice";
import { createTtsSlice, type TtsSlice } from "./slices/ttsSlice";
import { createApiSlice, type ApiSlice } from "./slices/apiSlice";
import { createModelsSlice, type ModelsSlice } from "./slices/modelsSlice";
import { createRuntimeSlice, type RuntimeSlice } from "./slices/runtimeSlice";
import { createSettingsSlice, type SettingsSlice } from "./slices/settingsSlice";
import { createInfrastructureSlice, type InfrastructureSlice } from "./slices/infrastructureSlice";

export type AppState = UiSlice & AsrSlice & TtsSlice & ApiSlice & ModelsSlice & RuntimeSlice & SettingsSlice & InfrastructureSlice;

export const useAppStore = create<AppState>()((set) => ({
  ...createUiSlice(set),
  ...createAsrSlice(set),
  ...createTtsSlice(set),
  ...createApiSlice(set),
  ...createModelsSlice(set),
  ...createRuntimeSlice(set),
  ...createSettingsSlice(set),
  ...createInfrastructureSlice(set),
}));

// Re-export shared pieces for backward compatibility
export { DEFAULT_SUB_MENUS } from "./slices/shared";
export type { Module, HistoryRecord, RuntimeLog, RuntimeLogLevel, TranscribeTask, TtsTask, ModelFramework, ModelItemState, EngineState } from "./types";
