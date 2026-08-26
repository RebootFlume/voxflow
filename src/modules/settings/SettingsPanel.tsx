import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { useAppStore } from "@/stores";
import { AppearancePanel } from "./AppearancePanel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LOCALE_OPTIONS, t } from "@/lib/i18n";

export function SettingsPanel() {
  const sub = useAppStore((s) => s.activeSubMenu);
  const overlay = useAppStore((s) => s.overlay);
  const updateOverlay = useAppStore((s) => s.updateOverlay);
  const locale = useAppStore((s) => s.locale);
  const setLocale = useAppStore((s) => s.setLocale);

  if (sub === "general") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t(locale, "general.title")}</CardTitle>
          <CardDescription>{t(locale, "general.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="text-sm font-medium">{t(locale, "general.overlay")}</div>
              <div className="text-xs text-muted-foreground">{t(locale, "general.overlay.desc")}</div>
            </div>
            <Switch checked={overlay.visible} onCheckedChange={(visible) => updateOverlay({ visible })} />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="text-sm font-medium">{t(locale, "general.locale")}</div>
              <div className="text-xs text-muted-foreground">{t(locale, "general.locale.desc")}</div>
            </div>
            <Select value={locale} onValueChange={(v) => setLocale(v as typeof locale)}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCALE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="text-sm font-medium">{t(locale, "general.autostart")}</div>
              <div className="text-xs text-muted-foreground">{t(locale, "general.autostart.desc")}</div>
            </div>
            <Switch checked={false} disabled />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (sub === "appearance") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t(locale, "appearance.title")}</CardTitle>
          <CardDescription>{t(locale, "appearance.desc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <AppearancePanel />
        </CardContent>
      </Card>
    );
  }

  // about
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "about.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">VoxFlow</span>
          <Badge variant="secondary">v0.1.0</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{t(locale, "about.desc")}</p>
      </CardContent>
    </Card>
  );
}
