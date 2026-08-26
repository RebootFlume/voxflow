export interface SettingsSlice {
  overlay: { visible: boolean };
  theme: { mode: "system" | "light" | "dark"; accent: string };
  locale: "zh" | "en";
  updateOverlay: (patch: Partial<SettingsSlice["overlay"]>) => void;
  updateTheme: (patch: Partial<SettingsSlice["theme"]>) => void;
  setThemeMode: (mode: SettingsSlice["theme"]["mode"]) => void;
  setAccent: (hex: string) => void;
  setLocale: (l: "zh" | "en") => void;
}

export const createSettingsSlice = (set: (partial: Partial<SettingsSlice> | ((s: SettingsSlice) => Partial<SettingsSlice>)) => void): SettingsSlice => ({
  overlay: { visible: true },
  theme: { mode: "system", accent: "#18181b" },
  locale: "zh",
  updateOverlay: (patch) => set((s) => ({ overlay: { ...s.overlay, ...patch } })),
  updateTheme: (patch) => set((s) => ({ theme: { ...s.theme, ...patch } })),
  setThemeMode: (mode) => set((s) => ({ theme: { ...s.theme, mode } })),
  setAccent: (accent) => set((s) => ({ theme: { ...s.theme, accent } })),
  setLocale: (locale) => set({ locale }),
});
