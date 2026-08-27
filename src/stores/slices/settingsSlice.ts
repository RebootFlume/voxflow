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

/**
 * 首次启动默认语言：跟随系统语言（zh 开头 → 中文，其他 → 英文）。
 * 仅影响首次启动（localStorage 无持久化值时）；老用户已有持久化 locale，merge 覆盖此默认值。
 */
function detectSystemLocale(): "zh" | "en" {
  try {
    const lang = navigator.language ?? "";
    return lang.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    return "zh";
  }
}

export const createSettingsSlice = (set: (partial: Partial<SettingsSlice> | ((s: SettingsSlice) => Partial<SettingsSlice>)) => void): SettingsSlice => ({
  overlay: { visible: true },
  theme: { mode: "system", accent: "#18181b" },
  locale: detectSystemLocale(),
  updateOverlay: (patch) => set((s) => ({ overlay: { ...s.overlay, ...patch } })),
  updateTheme: (patch) => set((s) => ({ theme: { ...s.theme, ...patch } })),
  setThemeMode: (mode) => set((s) => ({ theme: { ...s.theme, mode } })),
  setAccent: (accent) => set((s) => ({ theme: { ...s.theme, accent } })),
  setLocale: (locale) => set({ locale }),
});
