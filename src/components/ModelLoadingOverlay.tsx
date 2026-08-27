import { Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";

/**
 * 全局模型加载遮罩。
 *
 * 任一引擎（ASR / TTS）处于 loading 时全屏遮罩：
 *  - 禁止用户操作（模态式拦截，避免加载中误触/重复切换）
 *  - 展示当前加载的模型 + 阶段进度（unload → loading → ready）
 *
 * 挂载于 App 根，只读 store，不发起任何查询。
 */
export function ModelLoadingOverlay() {
  const locale = useAppStore((s) => s.locale);
  const asr = useAppStore((s) => s.engines.asr);
  const tts = useAppStore((s) => s.engines.tts);

  // 任一引擎加载中 → 遮罩；TTS 加载同样拦截（加载期间不应操作）
  const loading = asr.status === "loading" || tts.status === "loading";
  const active = asr.status === "loading" ? asr : tts;
  const model = active.model || "";
  const stage = active.stage;

  if (!loading) return null;

  // 阶段 → 进度 + 文案（框架无关的通用阶段集合）
  const stageInfo: Record<string, { value: number; labelKey: string }> = {
    unload: { value: 15, labelKey: "overlay.stage.unload" },
    loading: { value: 45, labelKey: "overlay.stage.loading" },
    initializing: { value: 80, labelKey: "overlay.stage.initializing" },
    ready: { value: 100, labelKey: "overlay.stage.ready" },
  };
  const info = stageInfo[stage ?? "loading"] ?? stageInfo.loading;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[340px] rounded-xl border bg-card p-6 shadow-xl">
        <div className="mb-4 flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {t(locale, "overlay.title", { model })}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(locale, info.labelKey)}
            </p>
          </div>
        </div>
        <Progress value={info.value} className="h-1.5" />
      </div>
    </div>
  );
}
