import { useEffect } from "react";
import { useAppStore } from "@/stores";

/**
 * 同步 documentElement 的 .dark 与 --primary/--ring 等 CSS 变量。
 * - mode: system / light / dark
 * - accent: hex 颜色（#rrggbb），同步写入 --primary / --ring
 */
export function useThemeSync() {
  const mode = useAppStore((s) => s.theme.mode);
  const accent = useAppStore((s) => s.theme.accent);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const isDark = mode === "dark" || (mode === "system" && mql.matches);
      document.documentElement.classList.toggle("dark", isDark);
    };
    apply();
    if (mode === "system") {
      mql.addEventListener("change", apply);
      return () => mql.removeEventListener("change", apply);
    }
  }, [mode]);

  useEffect(() => {
    if (!accent) return;
    const hex = accent.trim();
    if (!/^#([0-9a-f]{6})$/i.test(hex)) return;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // 相对亮度，决定前景色
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const fg = luminance > 0.6 ? "0 0% 9%" : "0 0% 98%";
    const hsl = rgbToHslString(r, g, b);
    const root = document.documentElement;
    root.style.setProperty("--primary", hsl);
    root.style.setProperty("--ring", hsl);
    root.style.setProperty("--primary-foreground", fg);
  }, [accent]);
}

function rgbToHslString(r: number, g: number, b: number): string {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
      case gn: h = (bn - rn) / d + 2; break;
      case bn: h = (rn - gn) / d + 4; break;
    }
    h /= 6;
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}
