import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";
import { runtimeKeyOf } from "@/lib/modelState";

/**
 * 缺少推理框架的全局横幅（可操作出口）。
 *
 * 为什么需要：框架缺失此前只写运行日志（次要 UI），而模型卡片的错误文案又要求
 * 「已选中且已加载」才渲染 —— 结果用户完全看不到失败原因，只看到加载不动。
 *
 * 显示条件：**已下载的模型**所依赖的框架未就绪（missing / incomplete）；
 * 不用该框架时不打扰。CTA 直达「模型 → 推理框架」页。
 */
export function RuntimeAlert() {
  const locale = useAppStore((s) => s.locale);
  const packages = useAppStore((s) => s.runtime.packages);
  const items = useAppStore((s) => s.models.items);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const setActiveSubMenu = useAppStore((s) => s.setActiveSubMenu);

  if (!packages) return null;

  // 已下载模型所依赖的框架里，哪些没就绪
  const needed = new Set<string>();
  for (const m of items) {
    if (m.state !== "downloaded") continue;
    const key = runtimeKeyOf(m);
    if (key) needed.add(key);
  }
  const broken = packages.filter((p) => needed.has(p.framework) && p.state !== "ready");
  if (broken.length === 0) return null;

  const names = broken.map((p) => p.name).join(" / ");
  const hasIncomplete = broken.some((p) => p.state === "incomplete");

  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
          {t(locale, "runtime.banner.title", { list: names })}
        </p>
        <p className="mt-0.5 text-xs text-amber-700/80 dark:text-amber-300/80">
          {t(locale, hasIncomplete ? "runtime.banner.incomplete" : "runtime.banner.desc")}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0 border-amber-500/40"
        onClick={() => {
          setActiveModule("models");
          setActiveSubMenu("framework");
        }}
      >
        {t(locale, "runtime.banner.cta")}
      </Button>
    </div>
  );
}
