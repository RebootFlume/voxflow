import { Minus, Square, X } from "lucide-react";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";

export function TitleBar() {
  async function minimize() {
    await window.voxflow.window.minimize();
  }
  async function toggleMaximize() {
    await window.voxflow.window.toggleMaximize();
  }
  async function close() {
    await window.voxflow.window.close();
  }

  const locale = useAppStore((s) => s.locale);

  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b bg-background select-none app-drag-region">
      {/* 左侧：应用图标 + 拖动区域 + 标题 */}
      <div className="flex items-center gap-2 pl-3 app-drag-region">
        {/*
          注意：必须是相对路径 `./`。
          Tauri 版从 http://tauri.localhost/ 加载，写 `/voxflow-icon.png` 能取到 public 根；
          Electron 打包后用 file:// 打开，绝对路径会被解析成 `file:///D:/voxflow-icon.png`
          （盘符根），图片 404 → 左上角显示破图。
          Vite 只会改写 HTML 里的绝对路径，不会改 JSX 里的字符串，所以这里必须手写相对路径。
        */}
        <img
          src="./voxflow-icon.png"
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
