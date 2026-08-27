import { Minus, Square, X } from "lucide-react";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";

export function TitleBar() {
  async function minimize() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    getCurrentWindow().minimize();
  }
  async function toggleMaximize() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    getCurrentWindow().toggleMaximize();
  }
  async function close() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    getCurrentWindow().close();
  }

  const locale = useAppStore((s) => s.locale);

  return (
    <div
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center justify-between border-b bg-background select-none"
    >
      {/* 左侧：应用图标 + 拖动区域 + 标题 */}
      <div data-tauri-drag-region className="flex items-center gap-2 pl-3">
        <img
          src="/voxflow-icon.png"
          alt="VoxFlow"
          className="h-4 w-4 rounded-[4px]"
          draggable={false}
        />
        <span className="text-xs font-semibold tracking-tight text-muted-foreground">VoxFlow</span>
      </div>

      {/* 右侧：窗口控制按钮 */}
      <div className="flex h-full">
        <button
          onClick={() => void minimize()}
          className="flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t(locale, "common.minimize")}
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          onClick={() => void toggleMaximize()}
          className="flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t(locale, "common.maximize")}
        >
          <Square className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => void close()}
          className="flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-red-500 hover:text-white"
          aria-label={t(locale, "common.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
