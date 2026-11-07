import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";

/**
 * 显存占用：总显存 + 已用 + 各框架占用。
 *
 * 数据来自 App 根挂载的全局轮询（useVramPoller：15s 一轮，转写/合成中与窗口隐藏时暂停），
 * 本组件只读 store，不自己发查询 —— 快速切页不会重复拉起 nvidia-smi / WMI。
 *
 * variant="inline"：内联小节，塞在「推理设备」卡片底部 —— 选设备时就能看到余量，
 *   不用把「模型与设备」页滚到底才能看到进度条。
 * variant="card"：独立卡片，留给需要单独展示显存的页面（如以后的全局面板）。
 */
export function VramMonitorCard({ variant = "card" }: { variant?: "card" | "inline" }) {
  const locale = useAppStore((s) => s.locale);
  const vram = useAppStore((s) => s.vram);
  const inline = variant === "inline";

  const pct = vram && vram.total > 0 ? Math.round((vram.used / vram.total) * 100) : 0;

  const body = (
    <>
      {!vram ? (
        // 首次轮询回来之前（冷启动时 WMI 实测约 3s）别谎报「没有 GPU」
        <p className="text-xs text-muted-foreground/70">{t(locale, "asr.vram.loading")}</p>
      ) : vram.total > 0 ? (
        <>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {inline ? t(locale, "asr.vram.title") : t(locale, "asr.vram.usage")}
            </span>
            <span className="tabular-nums">
              {(vram.used / 1024).toFixed(1)} / {(vram.total / 1024).toFixed(1)} GB ({pct}%)
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-all ${pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : "bg-emerald-500"}`}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          {inline ? (
            // 内联版：各框架压成一行，省高度；估算值用「≈」标注，悬停看说明
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              {Object.keys(vram.frameworks).length === 0 ? (
                <span className="text-muted-foreground/70">{t(locale, "asr.vram.noDetail")}</span>
              ) : (
                Object.entries(vram.frameworks).map(([fw, v]) => (
                  <span
                    key={fw}
                    className="whitespace-nowrap"
                    title={v.source === "estimate" ? t(locale, "asr.vram.estimated") : undefined}
                  >
                    {fw} {v.source === "estimate" ? "≈" : ""}
                    <span className="tabular-nums">{(v.mb / 1024).toFixed(2)} GB</span>
                  </span>
                ))
              )}
            </div>
          ) : (
            <div className="space-y-1 text-xs text-muted-foreground">
              {/* 各框架占用：键由 Rust 下发；source=estimate 时标注「估算」，其余为驱动真值 */}
              {Object.entries(vram.frameworks).map(([fw, v]) => (
                <div key={fw} className="flex justify-between">
                  <span>
                    {fw}
                    {v.source === "estimate" ? ` · ${t(locale, "asr.vram.estimated")}` : ""}
                  </span>
                  <span className="tabular-nums">
                    {v.source === "estimate" ? "≈" : ""}
                    {(v.mb / 1024).toFixed(2)} GB
                  </span>
                </div>
              ))}
              {Object.keys(vram.frameworks).length === 0 && (
                <p className="text-xs text-muted-foreground/70">{t(locale, "asr.vram.noDetail")}</p>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{t(locale, "asr.vram.noGpu")}</p>
      )}
    </>
  );

  if (inline) {
    // 与卡片上半部分（设备下拉、输入设备）之间拉一条分隔线，标题说明放 title 里省高度
    return (
      <div className="space-y-2 border-t pt-3" title={t(locale, "asr.vram.desc")}>
        {body}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t(locale, "asr.vram.title")}</CardTitle>
        <CardDescription>{t(locale, "asr.vram.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">{body}</CardContent>
    </Card>
  );
}
