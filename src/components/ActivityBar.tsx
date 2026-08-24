import {
  Mic,
  Volume2,
  Globe,
  History,
  PackageOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore, type Module } from "@/stores/app";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";

interface ActivityItem {
  id: Module;
  icon: LucideIcon;
  labelKey: string;
}

const TOP_ITEMS: ActivityItem[] = [
  { id: "asr", icon: Mic, labelKey: "nav.asr" },
  { id: "tts", icon: Volume2, labelKey: "nav.tts" },
  { id: "api", icon: Globe, labelKey: "nav.api" },
  { id: "models", icon: PackageOpen, labelKey: "nav.models" },
  { id: "history", icon: History, labelKey: "nav.history" },
];

const BOTTOM_ITEMS: ActivityItem[] = [
  { id: "settings", icon: Settings, labelKey: "nav.settings" },
];

function ActivityButton({ item }: { item: ActivityItem }) {
  const activeModule = useAppStore((s) => s.activeModule);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const locale = useAppStore((s) => s.locale);
  const label = t(locale, item.labelKey);
  const Icon = item.icon;
  const active = activeModule === item.id;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => setActiveModule(item.id)}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cn(
            "relative flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground",
            active && "bg-accent text-foreground",
          )}
        >
          {active && (
            <span className="absolute left-[-12px] top-1/2 h-6 w-[2px] -translate-y-1/2 rounded-full bg-primary" />
          )}
          <Icon className="h-5 w-5" strokeWidth={1.8} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function ActivityBar() {
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const locale = useAppStore((s) => s.locale);
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleLabel = t(locale, collapsed ? "nav.expand" : "nav.collapse");

  return (
    <TooltipProvider delayDuration={200}>
      <aside className="flex h-full w-12 shrink-0 flex-col items-center justify-between border-r bg-card py-2">
        <div className="flex flex-col items-center gap-1">
          {TOP_ITEMS.map((item) => (
            <ActivityButton key={item.id} item={item} />
          ))}
        </div>
        <div className="flex flex-col items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggleSidebar}
                aria-label={toggleLabel}
                className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ToggleIcon className="h-5 w-5" strokeWidth={1.8} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {toggleLabel}
            </TooltipContent>
          </Tooltip>
          {BOTTOM_ITEMS.map((item) => (
            <ActivityButton key={item.id} item={item} />
          ))}
        </div>
      </aside>
    </TooltipProvider>
  );
}
