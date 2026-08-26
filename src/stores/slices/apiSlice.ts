export interface ApiSlice {
  api: {
    enabled: boolean;
    host: string;
    port: number;
    apiKey: string;
    endpoints: { asr: boolean; tts: boolean };
  };
  updateApi: (patch: Partial<ApiSlice["api"]>) => void;
  toggleApi: (on: boolean) => void;
}

export const createApiSlice = (set: (partial: Partial<ApiSlice> | ((s: ApiSlice) => Partial<ApiSlice>)) => void): ApiSlice => ({
  api: { enabled: false, host: "127.0.0.1", port: 9870, apiKey: "", endpoints: { asr: false, tts: false } },
  updateApi: (patch) => set((s) => ({ api: { ...s.api, ...patch } })),
  toggleApi: (on) => set((s) => ({ api: { ...s.api, enabled: on, endpoints: { asr: on, tts: on } } })),
});
