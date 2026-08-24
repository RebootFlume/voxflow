import { Button } from "@/components/ui/button";
import { RuntimeLogView } from "@/components/RuntimeLogView";
import { useAppStore } from "@/stores/app";
import { t } from "@/lib/i18n";

export function RuntimeLogsPanel() {
  const logs = useAppStore((s) => s.runtimeLogs);
  const clearLogs = useAppStore((s) => s.clearLogs);
  const locale = useAppStore((s) => s.locale);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{t(locale, "runtime.desc")}</p>
        <Button variant="outline" size="sm" onClick={clearLogs} disabled={logs.length === 0}>
          {t(locale, "common.clear")}
        </Button>
      </div>
      <RuntimeLogView className="min-h-0 flex-1 border py-3 text-xs leading-6" />
    </div>
  );
}
