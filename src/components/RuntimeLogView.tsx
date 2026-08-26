import { useEffect, useRef } from "react";
import { useAppStore, type RuntimeLogLevel } from "@/stores";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const LEVEL_COLOR: Record<RuntimeLogLevel, string> = {
  info: "text-muted-foreground",
  warn: "text-amber-500",
  error: "text-destructive",
  success: "text-emerald-500",
};

/**
 * 终端式只读日志视口。
 * 供 Sidebar 底部或历史面板底部挂载。
 */
export function RuntimeLogView({ className, maxLines = 120 }: { className?: string; maxLines?: number }) {
  const logs = useAppStore((s) => s.runtimeLogs);
  const locale = useAppStore((s) => s.locale);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs.length]);

  const visible = logs.slice(-maxLines);

  return (
    <div
      ref={ref}
      className={cn(
        "overflow-y-auto rounded-md border bg-zinc-950 px-2 py-1.5 font-mono text-[11px] leading-5 text-zinc-300",
        className,
      )}
    >
      {visible.length === 0 ? (
        <span className="text-zinc-500">{t(locale, "logs.waiting")}</span>
      ) : (
        visible.map((e) => (
          <div key={e.id} className="whitespace-pre-wrap break-all">
            <span className="text-zinc-500">[{e.ts}]</span>{" "}
            <span className={cn(LEVEL_COLOR[e.level])}>{e.msg}</span>
          </div>
        ))
      )}
    </div>
  );
}


