import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";

/** 用户在预检弹框里的选择：取消 / 用 CPU 加载 / 仍用 GPU 试 */
export type VramGuardChoice = "cancel" | "cpu" | "force";

interface VramGuardDialogProps {
  open: boolean;
  model: string;
  device: string;
  needMb: number | null;
  freeMb: number | null;
  totalMb: number | null;
  onChoose: (choice: VramGuardChoice) => void;
}

/**
 * 加载前显存预检弹框（受控组件）。
 *
 * 由调用方在 Rust 预检返回 `ok=false` 时打开；按钮回调只上报选择，
 * 真正「怎么加载」由调用方（useVramGuard）决定 —— 弹框本身不调加载命令。
 */
export function VramGuardDialog({
  open,
  model,
  device,
  needMb,
  freeMb,
  totalMb,
  onChoose,
}: VramGuardDialogProps) {
  const locale = useAppStore((s) => s.locale);
  if (!open) return null;

  // MB → GB 展示值；预检没给出数字时显示 "?"（不编造）
  const gb = (mb: number | null) =>
    mb === null || !Number.isFinite(mb) ? "?" : (mb / 1024).toFixed(1);

  return (
    <div className="fixed inset-0 z-[105] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[420px] rounded-xl border bg-card p-6 shadow-xl">
        <div className="mb-3 flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{t(locale, "vram.guard.title")}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {t(locale, "vram.guard.target", { model, device: device.toUpperCase() })}
            </p>
          </div>
        </div>

        {/* 数字写清楚：需要 / 可用 / 总显存 */}
        <p className="text-sm text-foreground">
          {t(locale, "vram.guard.desc", {
            need: gb(needMb),
            free: gb(freeMb),
            total: gb(totalMb),
          })}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">{t(locale, "vram.guard.hint")}</p>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onChoose("cancel")}>
            {t(locale, "vram.guard.cancel")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onChoose("cpu")}>
            {t(locale, "vram.guard.useCpu")}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => onChoose("force")}>
            {t(locale, "vram.guard.force")}
          </Button>
        </div>
      </div>
    </div>
  );
}
