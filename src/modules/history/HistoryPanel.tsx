import { useMemo, useState } from "react";
import { Copy, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";
import { RuntimeLogsPanel } from "@/modules/runtime/RuntimeLogsPanel";

export function HistoryPanel() {
  const sub = useAppStore((s) => s.activeSubMenu);
  const locale = useAppStore((s) => s.locale);
  const records = useAppStore((s) => s.history.records);
  const removeHistoryRecord = useAppStore((s) => s.removeHistoryRecord);
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => records.filter((r) => r.text.toLowerCase().includes(query.toLowerCase())),
    [records, query],
  );

  if (sub === "runtime") return <RuntimeLogsPanel />;

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t(locale, "history.searchPlaceholder")}
          className="pl-8"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <ScrollArea className="flex-1 rounded-md border">
        <div className="divide-y">
          {filtered.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              {t(locale, "history.empty")}
            </div>
          ) : (
            filtered.map((r) => (
              <div key={r.id} className="group flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-sm">{r.text}</p>
                  <p className="text-xs text-muted-foreground">{r.time}</p>
                </div>
                <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t(locale, "common.copy")}
                    title={t(locale, "common.copy")}
                    onClick={() => navigator.clipboard.writeText(r.text)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t(locale, "common.delete")}
                    title={t(locale, "common.delete")}
                    onClick={() => removeHistoryRecord(r.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary">{t(locale, "history.count", { n: records.length })}</Badge>
        <span>{t(locale, "history.storageHint")}</span>
      </div>
    </div>
  );
}
