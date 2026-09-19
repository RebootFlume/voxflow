import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";

/** 显示延迟：加载快于此值 → 全程不显示遮罩（TTS 选择模型属瞬时校验，避免闪黑） */
const SHOW_DELAY_MS = 300;
/** 最短停留：一旦显示，至少停留这么久，避免长加载收尾时闪一下 */
const MIN_VISIBLE_MS = 500;

/**
 * 全局模型加载遮罩。
 *
 * 任一引擎（ASR / TTS）处于 loading 时全屏遮罩：
 *  - 禁止用户操作（模态式拦截，避免加载中误触/重复切换）
 *  - 展示当前加载的模型 + 阶段进度（unload → loading → ready）
 *
 * 防闪策略（重要）：
 *   TTS「加载」是瞬时校验（仅检查文件存在性，几十毫秒），若一 loading 就铺黑罩，
 *   会表现为"选模型时页面闪过一个黑块"。因此：
 *     · 加载快于 `SHOW_DELAY_MS` → 全程不显示遮罩（但仍按原语义锁定状态变更）
 *     · 一旦显示，至少停留 `MIN_VISIBLE_MS`，避免长加载收尾瞬间闪一下
 *
 * 挂载于 App 根，只读 store，不发起任何查询。
 */
export function ModelLoadingOverlay() {
  const locale = useAppStore((s) => s.locale);
  const asr = useAppStore((s) => s.engines.asr);
  const tts = useAppStore((s) => s.engines.tts);

  // 任一引擎加载中 → 遮罩；TTS 加载同样拦截（加载期间不应操作）
  const loading = asr.status === "loading" || tts.status === "loading";
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);

  // 延迟显示：loading 在 SHOW_DELAY_MS 内结束 → 全程不显示（瞬时加载不再闪黑罩）
  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => {
      shownAt.current = Date.now();
      setVisible(true);
    }, SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  // 最短停留：已显示后即使 loading 结束，也留满 MIN_VISIBLE_MS 再隐藏
  useEffect(() => {
    if (loading || !visible) return;
    const remain = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt.current));
    const timer = window.setTimeout(() => setVisible(false), remain);
    return () => window.clearTimeout(timer);
  }, [loading, visible]);

  const active = asr.status === "loading" ? asr : tts;
  const model = active.model || "";
  const stage = active.stage;

  if (!visible) return null;

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
