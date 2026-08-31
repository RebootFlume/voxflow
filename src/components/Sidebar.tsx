import { cn } from "@/lib/utils";
import { useAppStore, DEFAULT_SUB_MENUS } from "@/stores";
import { t } from "@/lib/i18n";

const SUB_MENU_LABEL_KEYS: Record<string, string> = {
  hotkey: "submenu.hotkey",
  model: "submenu.model",
  service: "submenu.service",
  "endpoint-status": "submenu.endpoint-status",
  console: "submenu.console",
  records: "submenu.records",
  runtime: "submenu.runtime",
  settings: "submenu.settings",
  framework: "submenu.framework",
  asr: "submenu.asr",
  tts: "submenu.tts",
  "voice-settings": "submenu.voice-settings",
  synthesize: "submenu.synthesize",
  "model-device": "submenu.model-device",
  transcribe: "submenu.transcribe",
  general: "submenu.general",
  appearance: "submenu.appearance",
  about: "submenu.about",
};

const MODULE_TITLE_KEYS: Record<string, string> = {
  asr: "sidebar.asr",
  tts: "sidebar.tts",
  api: "sidebar.api",
  history: "sidebar.history",
  models: "sidebar.models",
  settings: "sidebar.settings",
};

export function Sidebar() {
  const activeModule = useAppStore((s) => s.activeModule);
  const activeSubMenu = useAppStore((s) => s.activeSubMenu);
  const setActiveSubMenu = useAppStore((s) => s.setActiveSubMenu);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const locale = useAppStore((s) => s.locale);

  const items = DEFAULT_SUB_MENUS[activeModule];

  if (collapsed) return null;

  return (
    <nav className="flex h-full w-[200px] shrink-0 flex-col border-r bg-card">
      <div className="px-4 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t(locale, MODULE_TITLE_KEYS[activeModule])}
      </div>
      <div className="flex flex-col gap-0.5 px-2">
        {items.map((key) => {
          const active = activeSubMenu === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setActiveSubMenu(key)}
              className={cn(
                "rounded-md px-3 py-1.5 text-left text-[13px] text-muted-foreground transition-colors",
                "hover:bg-accent hover:text-foreground",
                active && "bg-primary/10 font-medium text-primary hover:bg-primary/15 hover:text-primary",
              )}
            >
              {t(locale, SUB_MENU_LABEL_KEYS[key] ?? key)}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
