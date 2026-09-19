export interface RuntimePkgState {
  framework: string;
  name: string;
  /** 运行时版本标签（Rust 下发，如 b10622 / v1.13.6） */
  version: string;
  installed: boolean;
  state: "ready" | "incomplete" | "missing";
  missing: string[];
  dir: string;
}

export interface InfrastructureSlice {
  io: { exportDir: string };
  gpu: { available: boolean; name: string; deviceCount: number };
  capabilities: { ffmpeg: boolean };
  useRustEngine: boolean;
  sidebarCollapsed: boolean;
  /** 推理框架（libs）安装状态：检测结果 + 检测时间；null = 尚未检测 */
  runtime: { packages: RuntimePkgState[] | null; lastUpdate: number };
  /** 显存监控（全局单例轮询，不随组件生命周期）：frameworks = 框架 id → 占用 MB（Rust 下发键） */
  vram: { total: number; used: number; frameworks: Record<string, number>; lastUpdate: number };
  updateIo: (patch: Partial<InfrastructureSlice["io"]>) => void;
  setAudioDevices: (current: string, currentName: string) => void;
  audioDevices: { current: string; currentName: string };
  setGpu: (available: boolean, name: string, deviceCount: number) => void;
  setCapabilities: (patch: Partial<InfrastructureSlice["capabilities"]>) => void;
  setRuntime: (packages: RuntimePkgState[] | null) => void;
  setUseRustEngine: (v: boolean) => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;
  setVram: (patch: Partial<InfrastructureSlice["vram"]>) => void;
}

export const createInfrastructureSlice = (set: (partial: Partial<InfrastructureSlice> | ((s: InfrastructureSlice) => Partial<InfrastructureSlice>)) => void): InfrastructureSlice => ({
  io: { exportDir: "" },
  gpu: { available: false, name: "", deviceCount: 0 },
  capabilities: { ffmpeg: false },
  useRustEngine: true,
  sidebarCollapsed: false,
  audioDevices: { current: "default", currentName: "…" },
  runtime: { packages: null, lastUpdate: 0 },
  vram: { total: 0, used: 0, frameworks: {}, lastUpdate: 0 },
  updateIo: (patch) => set((s) => ({ io: { ...s.io, ...patch } })),
  setAudioDevices: (current, currentName) => set({ audioDevices: { current, currentName } }),
  setGpu: (available, name, deviceCount) => set({ gpu: { available, name, deviceCount } }),
  setCapabilities: (patch) => set((s) => ({ capabilities: { ...s.capabilities, ...patch } })),
  setRuntime: (packages) => set({ runtime: { packages, lastUpdate: Date.now() } }),
  setUseRustEngine: (useRustEngine) => set({ useRustEngine }),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setVram: (patch) => set((s) => ({ vram: { ...s.vram, ...patch, lastUpdate: Date.now() } })),
});
