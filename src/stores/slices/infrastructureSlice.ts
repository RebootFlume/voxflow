export interface InfrastructureSlice {
  io: { exportDir: string };
  gpu: { available: boolean; name: string; deviceCount: number };
  capabilities: { ffmpeg: boolean };
  useRustEngine: boolean;
  sidebarCollapsed: boolean;
  updateIo: (patch: Partial<InfrastructureSlice["io"]>) => void;
  setAudioDevices: (current: string, currentName: string) => void;
  audioDevices: { current: string; currentName: string };
  setGpu: (available: boolean, name: string, deviceCount: number) => void;
  setCapabilities: (patch: Partial<InfrastructureSlice["capabilities"]>) => void;
  setUseRustEngine: (v: boolean) => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;
}

export const createInfrastructureSlice = (set: (partial: Partial<InfrastructureSlice> | ((s: InfrastructureSlice) => Partial<InfrastructureSlice>)) => void): InfrastructureSlice => ({
  io: { exportDir: "" },
  gpu: { available: false, name: "", deviceCount: 0 },
  capabilities: { ffmpeg: false },
  useRustEngine: true,
  sidebarCollapsed: false,
  audioDevices: { current: "default", currentName: "…" },
  updateIo: (patch) => set((s) => ({ io: { ...s.io, ...patch } })),
  setAudioDevices: (current, currentName) => set({ audioDevices: { current, currentName } }),
  setGpu: (available, name, deviceCount) => set({ gpu: { available, name, deviceCount } }),
  setCapabilities: (patch) => set((s) => ({ capabilities: { ...s.capabilities, ...patch } })),
  setUseRustEngine: (useRustEngine) => set({ useRustEngine }),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
});
