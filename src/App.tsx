import { ActivityBar } from "@/components/ActivityBar";
import { useThemeSync } from "@/lib/theme";
import { Sidebar } from "@/components/Sidebar";
import { FloatingBar } from "@/components/FloatingBar";
import { ModelLoadingOverlay } from "@/components/ModelLoadingOverlay";
import { StartupSplash } from "@/components/StartupSplash";
import { TitleBar } from "@/components/TitleBar";
import { AsrPanel } from "@/modules/asr/AsrPanel";
import { TtsPanel } from "@/modules/tts/TtsPanel";
import { ApiPanel } from "@/modules/api/ApiPanel";
import { HistoryPanel } from "@/modules/history/HistoryPanel";
import { SettingsPanel } from "@/modules/settings/SettingsPanel";
import { ModelsPanel } from "@/modules/models/ModelsPanel";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";
import { useSidecarEvents } from "@/hooks/useSidecarEvents";
import { useVramPoller } from "@/hooks/useVramPoller";
import { useHotkeySync, useStartupFallback, useModelLoadTimeout, useStatusReconcile } from "@/hooks/useStartup";
import { MODULE_ICONS, resolveHeading } from "@/config/modules";

function ModuleIcon() {
  const activeModule = useAppStore((s) => s.activeModule);
  const Icon = MODULE_ICONS[activeModule];
  return <Icon className="h-4 w-4 text-muted-foreground" />;
}

export default function App() {
  useThemeSync();
  useSidecarEvents();
  useVramPoller();
  useHotkeySync();
  useStartupFallback();
  useModelLoadTimeout();
  useStatusReconcile();
  const activeModule = useAppStore((s) => s.activeModule);
  const activeSubMenu = useAppStore((s) => s.activeSubMenu);
  const locale = useAppStore((s) => s.locale);
  const isRuntimeLogs = activeModule === "history" && activeSubMenu === "runtime";

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      <TitleBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ActivityBar />
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-hidden">
          <div className={isRuntimeLogs ? "flex h-full flex-col p-4" : "flex h-full w-full flex-col"}>
            {/* 紧凑页面头部（对齐 llm-gateway PageHeader 风格） */}
            <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
              <ModuleIcon />
              <h2 className="truncate text-sm font-medium text-foreground">
                {resolveHeading(activeModule, activeSubMenu, locale, t)}
              </h2>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pt-3">
              {activeModule === "asr" && <AsrPanel />}
              {activeModule === "tts" && <TtsPanel />}
              {activeModule === "api" && <ApiPanel />}
              {activeModule === "history" && <HistoryPanel />}
              {activeModule === "models" && <ModelsPanel />}
              {activeModule === "settings" && <SettingsPanel />}
            </div>
          </div>
        </main>
      </div>
      <div className="flex shrink-0 items-center justify-center border-t bg-background/80 py-1.5">
        <FloatingBar />
      </div>
      <ModelLoadingOverlay />
      <StartupSplash />
    </div>
  );
}
