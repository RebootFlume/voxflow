import { t } from "@/lib/i18n";
import { modelDisplayName } from "@/lib/modelState";
import { useAppStore, type ModelItemState } from "@/stores";

export type ModelStatus = "idle" | "loading" | "ready" | "error";

const EMPTY_ITEMS: ModelItemState[] = [];

/** 统一的模型加载状态徽标（loading / ready / error / idle），ASR 与 TTS 共用 */
/**
 * 「当前在起作用的模型」徽标：读**引擎实际状态**，与"选中了哪个模型"无关。
 * idle = 没有模型在跑（显示 "—"）；ready = 引擎里的模型名；loading/error 同理。
 */
export function ModelStatusBadge({ status, modelName }: { status: ModelStatus; modelName?: string }) {
  const locale = useAppStore((s) => s.locale);
  const items = useAppStore((s) => s.models?.items ?? EMPTY_ITEMS);
  // 模型身份键是"框架层/目录名"，展示时换回清单里的展示名
  const label = modelDisplayName(items, modelName ?? "");
  return (
    <>
      {status === "loading" && (
        <span className="text-amber-600 dark:text-amber-400">{t(locale, "models.status.loading")}...</span>
      )}
      {status === "ready" && <span className="text-emerald-600 dark:text-emerald-400">{label || "—"}</span>}
      {status === "error" && <span className="text-destructive">{t(locale, "models.status.error")}</span>}
      {status === "idle" && <span className="text-muted-foreground">—</span>}
    </>
  );
}
