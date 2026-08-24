import { Mic, Loader2, Check, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import { t } from "@/lib/i18n";

const STATUS_CONFIG = {
  idle: { icon: Mic, labelKey: "floating.idle", color: "text-muted-foreground", pulse: false },
  recording: { icon: Mic, labelKey: "floating.recording", color: "text-red-500", pulse: true },
  recognizing: { icon: Loader2, labelKey: "floating.recognizing", color: "text-amber-500", pulse: false },
  done: { icon: Check, labelKey: "floating.done", color: "text-emerald-500", pulse: false },
  error: { icon: AlertCircle, labelKey: "floating.error", color: "text-destructive", pulse: false },
} as const;

type StatusKey = keyof typeof STATUS_CONFIG;

/**
 * 悬浮状态条（P0 阶段先作为主窗口内嵌组件实现；
 * 阶段 3 将迁移为独立 always_on_top 窗口）。
 */
export function FloatingBar() {
  const asr = useAppStore((s) => s.asr);
  const overlayVisible = useAppStore((s) => s.overlay.visible);
  const locale = useAppStore((s) => s.locale);

  if (!overlayVisible) return null;

  // 兜底：旧 localStorage 经过 shallow merge 后 asr.status/volume 可能为 undefined
  const status: StatusKey = (asr?.status as StatusKey) && STATUS_CONFIG[asr.status as StatusKey] ? (asr.status as StatusKey) : "idle";
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;
  const volume = typeof asr?.volume === "number" ? asr.volume : 0;

  return (
    <div
      data-tauri-drag-region
      className="pointer-events-auto flex h-12 select-none items-center gap-3 rounded-full border bg-card/95 px-5 shadow-lg backdrop-blur"
    >
      <Icon
        className={cn("h-4 w-4 shrink-0", cfg.color, cfg.pulse && "animate-pulse", status === "recognizing" && "animate-spin")}
      />
      <span className="text-sm font-medium">{t(locale, cfg.labelKey)}</span>
      <div className="flex h-5 items-center gap-[3px]">
        {Array.from({ length: 12 }, (_, i) => {
          const level = Math.min(1, 0.15 + volume * (0.3 + ((i % 3) + 1) * 0.2));
          return (
            <span
              key={i}
              className={cn(
                "w-[3px] rounded-full transition-all duration-100",
                status === "recording" ? "bg-red-500" : "bg-muted-foreground/40",
              )}
              style={{ height: `${Math.max(3, level * 20)}px` }}
            />
          );
        })}
      </div>
    </div>
  );
}
