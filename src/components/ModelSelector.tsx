import { useAppStore, type ModelItemState, type ModelFramework } from "@/stores";
import { t } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { computeIsLoaded } from "@/lib/modelState";

const EMPTY_ITEMS: ModelItemState[] = [];

interface ModelSelectorProps {
  kind: "asr" | "tts";
  selected: string;
  onSelect: (name: string) => void;
  /** 按格式过滤（可选） */
  formatFilter?: ModelFramework;
  /** 只展示已下载的模型（默认 false） */
  downloadedOnly?: boolean;
}

function FormatBadge({ format }: { format: ModelFramework }) {
  const isOnnx = format === "onnx";
  return (
    <Badge
      variant="outline"
      className={`text-[10px] px-1.5 py-0 h-4 ${
        isOnnx
          ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
          : "border-sky-500/40 text-sky-600 dark:text-sky-400"
      }`}
    >
      {format.toUpperCase()}
    </Badge>
  );
}

export function ModelSelector({ kind, selected, onSelect, formatFilter, downloadedOnly = false }: ModelSelectorProps) {
  const items = useAppStore((s) => s.models?.items ?? EMPTY_ITEMS);
  const engineStatus = useAppStore((s) => s.engines?.[kind]?.status ?? "idle");

  const locale = useAppStore((s) => s.locale);

  // 过滤逻辑：kind + 可选 formatFilter + 状态
  const models = items.filter((i) => {
    if (i.kind !== kind) return false;
    // 格式过滤（仅 ASR 且指定 formatFilter 时生效）
    if (formatFilter && i.format !== formatFilter) return false;
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
        const statusLabel =
          isSelected && isLoaded
            ? status === "loading"
              ? t(locale, "common.modelLoading")
              : status === "ready"
                ? t(locale, "common.modelReady")
                : status === "error"
                  ? t(locale, "common.modelFailed")
                  : ""
            : isLoaded
              ? t(locale, "common.modelReady")
              : "";

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
                <FormatBadge format={m.format} />
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground pl-6">
                <span>{m.sizeGb} GB</span>
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
          </div>
        );
      })}
    </div>
  );
}
