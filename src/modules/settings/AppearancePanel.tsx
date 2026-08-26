import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";

const ACCENT_PRESETS: { hex: string; key: string }[] = [
  { hex: "#18181b", key: "appearance.accent.ink" },
  { hex: "#2563eb", key: "appearance.accent.blue" },
  { hex: "#0ea5e9", key: "appearance.accent.sky" },
  { hex: "#10b981", key: "appearance.accent.emerald" },
  { hex: "#f59e0b", key: "appearance.accent.amber" },
  { hex: "#ef4444", key: "appearance.accent.red" },
  { hex: "#a855f7", key: "appearance.accent.violet" },
  { hex: "#ec4899", key: "appearance.accent.pink" },
];

type ThemeMode = "system" | "light" | "dark";
const MODES: { value: ThemeMode; labelKey: string; descKey: string }[] = [
  { value: "system", labelKey: "appearance.mode.system", descKey: "appearance.mode.system.desc" },
  { value: "light", labelKey: "appearance.mode.light", descKey: "appearance.mode.light.desc" },
  { value: "dark", labelKey: "appearance.mode.dark", descKey: "appearance.mode.dark.desc" },
];

export function AppearancePanel() {
  const locale = useAppStore((s) => s.locale);
  const mode = useAppStore((s) => s.theme.mode);
  const accent = useAppStore((s) => s.theme.accent);
  const setThemeMode = useAppStore((s) => s.setThemeMode);
  const setAccent = useAppStore((s) => s.setAccent);

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">{t(locale, "appearance.mode")}</h3>
        <div className="grid grid-cols-3 gap-3">
          {MODES.map((m) => {
            const active = mode === m.value;
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => setThemeMode(m.value)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors",
                  active ? "border-primary bg-accent" : "border-border hover:bg-accent/50",
                )}
              >
                <div className="text-sm font-medium">{t(locale, m.labelKey)}</div>
                <div className="text-xs text-muted-foreground">{t(locale, m.descKey)}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">{t(locale, "appearance.accent")}</h3>
        <p className="text-xs text-muted-foreground">{t(locale, "appearance.accent.desc")}</p>
        <div className="flex flex-wrap gap-2.5">
          {ACCENT_PRESETS.map((p) => {
            const active = accent.toLowerCase() === p.hex.toLowerCase();
            return (
              <button
                key={p.hex}
                type="button"
                aria-label={t(locale, p.key)}
                title={t(locale, p.key)}
                onClick={() => setAccent(p.hex)}
                className={cn(
                  "relative flex h-9 w-9 items-center justify-center rounded-full border-2 transition-all",
                  active ? "border-foreground scale-105" : "border-transparent hover:scale-105",
                )}
                style={{ background: p.hex }}
              >
                {active && <Check className="h-4 w-4 text-white drop-shadow" />}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 pt-1">
          <label className="text-sm text-muted-foreground">{t(locale, "appearance.custom")}</label>
          <div className="relative">
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(accent) ? accent : "#18181b"}
              onChange={(e) => setAccent(e.target.value)}
              className="h-9 w-14 cursor-pointer rounded border bg-transparent p-1"
            />
          </div>
          <input
            value={accent}
            onChange={(e) => setAccent(e.target.value)}
            placeholder="#18181b"
            className="h-9 w-28 rounded-md border border-input bg-background px-3 font-mono text-sm"
            aria-label="custom accent hex"
          />
          <span className="text-xs text-muted-foreground">{t(locale, "appearance.custom.hint")}</span>
        </div>
      </div>
    </div>
  );
}
