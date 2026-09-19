import { useAppStore, type ModelItemState, type ModelFramework } from "@/stores";
import { t } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { computeIsLoaded, engineOf, runtimeKeyOf } from "@/lib/modelState";

const EMPTY_ITEMS: ModelItemState[] = [];

/** 引擎徽章配色（仅视觉查表；未登记引擎走默认样式 —— 新增框架无需改前端） */
const ENGINE_BADGE_CLASSES: Record<string, string> = {
  llama: "border-sky-500/40 text-sky-600 dark:text-sky-400",
  sherpa: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  torch: "border-orange-500/40 text-orange-600 dark:text-orange-400",
};

/** 模型大小显示：已下载用真实磁盘占用，未下载用清单预估值 */
function sizeLabel(m: ModelItemState): string {
  const gb = m.sizeOnDiskGb ?? m.sizeGb;
  return `${gb.toFixed(gb >= 10 ? 0 : 2)} GB`;
}

interface ModelSelectorProps {
  kind: "asr" | "tts";
  selected: string;
  onSelect: (name: string) => void;
  /** 按运行时包 key 过滤（可选） */
  formatFilter?: ModelFramework;
  /** 只展示已下载的模型（默认 false） */
  downloadedOnly?: boolean;
}

function FormatBadge({ item }: { item: ModelItemState }) {
  const engine = engineOf(item);
  const label = runtimeKeyOf(item) ?? engine ?? "unknown";
  return (
    <Badge
      variant="outline"
      className={`text-[10px] px-1.5 py-0 h-4 ${
        ENGINE_BADGE_CLASSES[engine ?? ""] ?? "border-muted-foreground/40 text-muted-foreground"
      }`}
    >
      {label.toUpperCase()}
    </Badge>
  );
}

export function ModelSelector({ kind, selected, onSelect, formatFilter, downloadedOnly = false }: ModelSelectorProps) {
  const items = useAppStore((s) => s.models?.items ?? EMPTY_ITEMS);
  const engineStatus = useAppStore((s) => s.engines?.[kind]?.status ?? "idle");
  const engineError = useAppStore((s) => s.engines?.[kind]?.error ?? null);
  const runtimePackages = useAppStore((s) => s.runtime.packages);

  const locale = useAppStore((s) => s.locale);

  // 过滤逻辑：kind + 可选 formatFilter + 状态
  const models = items.filter((i) => {
    if (i.kind !== kind) return false;
    // 运行时包 key 过滤（仅 ASR 且指定 formatFilter 时生效）
    if (formatFilter && runtimeKeyOf(i) !== formatFilter) return false;
    // 只展示已下载的模型（可加载的）
    if (downloadedOnly) return i.state === "downloaded";
    // 默认：已下载 或 当前选中（但选中但未下载的不显示，避免误导）
    return i.state === "downloaded" || (i.name === selected && i.state !== "not_downloaded");
  });

  if (models.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {formatFilter
          ? t(locale, "asr.framework.noModels")
          : t(locale, "common.noModels", { kind: kind === "asr" ? "ASR" : "TTS" })}
      </p>
    );
  }

  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
      {models.map((m) => {
        const isLoaded = computeIsLoaded(kind, m.name);
        const status = engineStatus;
        const isSelected = m.name === selected;
        // 失败原因只在该模型是当前选中时展示（否则会串台到别的模型）
        const isFailedHere = isSelected && status === "error";
        // 状态文案：不再要求 isLoaded —— 失败时 isLoaded=false，旧逻辑会让原因整段不渲染
        const statusLabel = isLoaded
          ? t(locale, "common.modelReady")
          : isSelected
            ? status === "loading"
              ? t(locale, "common.modelLoading")
              : status === "ready"
                ? t(locale, "common.modelReady")
                : status === "error"
                  ? t(locale, "common.modelFailed")
                  : ""
            : "";
        // 该模型所需框架未就绪 → 标注（用户不必先点一次才知道）
        const fwKey = runtimeKeyOf(m);
        const fwPkg = fwKey ? runtimePackages?.find((p) => p.framework === fwKey) : undefined;
        const fwBlocked = Boolean(fwPkg && fwPkg.state !== "ready");

        return (
          <div
            key={m.name}
            onClick={() => onSelect(m.name)}
            className={`flex items-center justify-between rounded-lg border p-3 cursor-pointer transition-all ${
              isSelected
                ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                : "border-border hover:border-primary/40 hover:bg-muted/50"
            }`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    isSelected
                      ? "border-primary bg-primary"
                      : "border-muted-foreground/40"
                  }`}
                >
                  {isSelected && (
                    <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
                  )}
                </span>
                <span className="text-sm font-medium truncate">{m.name}</span>
                <FormatBadge item={m} />
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground pl-6">
                <span>{sizeLabel(m)}</span>
                {fwBlocked && (
                  <span className="text-amber-600 dark:text-amber-400">
                    {t(locale, "runtime.needsFramework", { name: fwPkg?.name ?? "" })}
                  </span>
                )}
                {statusLabel && (
                  <span
                    className={
                      status === "loading"
                        ? "text-amber-600 dark:text-amber-400"
                        : status === "ready" || isLoaded
                          ? "text-emerald-600 dark:text-emerald-400"
                          : status === "error"
                            ? "text-destructive"
                            : ""
                    }
                  >
                    {statusLabel}
                  </span>
                )}
              </div>
            </div>
            {isFailedHere && engineError && (
              <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] leading-snug text-destructive">
                {engineError}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
