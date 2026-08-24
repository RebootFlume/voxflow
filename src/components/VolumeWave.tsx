import { cn } from "@/lib/utils";

const BARS = 24;

/**
 * 音量波形条：实时音量驱动的可视化。
 * volume: 0-1 实时音量；active: 录音中高亮。
 */
export function VolumeWave({ volume, active }: { volume: number; active?: boolean }) {
  return (
    <div className="flex h-12 items-center justify-center gap-1 rounded-md border bg-muted/40 px-4">
      {Array.from({ length: BARS }, (_, i) => {
        // 以 sin 打底噪，叠加实时音量，形成波动感
        const base = Math.abs(Math.sin((i / BARS) * Math.PI * 3)) * 0.15;
        const level = Math.min(1, base + volume * (0.3 + (i % 3) * 0.25));
        return (
          <span
            key={i}
            className={cn(
              "w-1.5 rounded-full transition-all duration-100",
              active ? "bg-primary" : "bg-muted-foreground/30",
            )}
            style={{ height: `${Math.max(8, level * 100)}%` }}
          />
        );
      })}
    </div>
  );
}
