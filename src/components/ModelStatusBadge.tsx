import { t } from "@/lib/i18n";
import { useAppStore } from "@/stores/app";

export type ModelStatus = "idle" | "loading" | "ready" | "error";

/** 统一的模型加载状态徽标（loading / ready / error / idle），ASR 与 TTS 共用 */
export function ModelStatusBadge({ status, modelName }: { status: ModelStatus; modelName?: string }) {
  const locale = useAppStore((s) => s.locale);
  return (
    <>
      {status === "loading" && (
        <span className="text-amber-600 dark:text-amber-400">{t(locale, "models.status.loading")}...</span>
      )}
      {status === "ready" && <span className="text-emerald-600 dark:text-emerald-400">{modelName ?? "—"}</span>}
      {status === "error" && <span className="text-destructive">{t(locale, "models.status.error")}</span>}
      {status === "idle" && <span className="text-muted-foreground">—</span>}
    </>
  );
}
