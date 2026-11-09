import { useState } from "react";
import { Check, Copy, Globe, Lock } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";
import { sendToSidecar } from "@/lib/ipc";

function EndpointLight({ label, online }: { label: string; online: boolean }) {
  const locale = useAppStore((s) => s.locale);
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "h-2.5 w-2.5 rounded-full",
          online ? "bg-emerald-500 shadow-[0_0_6px] shadow-emerald-500/60" : "bg-muted-foreground/30",
        )}
      />
      <span className="text-sm">{label}</span>
      <Badge variant={online ? "default" : "secondary"}>{t(locale, online ? "api.online" : "api.offline")}</Badge>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const locale = useAppStore((s) => s.locale);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copied ? t(locale, "common.copied") : t(locale, "common.copy")}
    </Button>
  );
}

export function ApiPanel() {
  const sub = useAppStore((s) => s.activeSubMenu);
  const api = useAppStore((s) => s.api);
  const updateApi = useAppStore((s) => s.updateApi);
  const locale = useAppStore((s) => s.locale);

  const startApi = (host?: string) => {
    void sendToSidecar({
      action: "start_api",
      host: host ?? api.host,
      port: api.port,
      api_key: api.apiKey,
    });
  };

  if (sub === "service") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t(locale, "api.service.title")}</CardTitle>
          <CardDescription>{t(locale, "api.service.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="text-sm font-medium">{t(locale, "api.service.external")}</div>
              <div className="text-xs text-muted-foreground">{t(locale, "api.service.external.desc")}</div>
            </div>
            <Switch
              checked={api.enabled}
              onCheckedChange={(on) => {
                useAppStore.getState().toggleApi(on);
                if (on) {
                  startApi();
                } else {
                  void sendToSidecar({ action: "stop_api" });
                }
              }}
            />
          </div>

          {/* 监听地址：平铺卡片 + 圆点单选。
              只有两个互斥选项，用下拉要把备选藏起来点一次才看得到 —— 而这两项的区别
              （谁能访问）恰恰是用户要判断的东西，平铺才能一眼比较。
              切换即生效：服务在跑就重启，与下拉版本行为一致。 */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t(locale, "api.service.host")}</label>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t(locale, "api.service.host")}>
              {[
                { value: "127.0.0.1", icon: Lock, titleKey: "api.service.host.localhost", descKey: "api.service.host.localhost.desc" },
                { value: "0.0.0.0", icon: Globe, titleKey: "api.service.host.lan", descKey: "api.service.host.lan.desc" },
              ].map(({ value, icon: Icon, titleKey, descKey }) => {
                const active = api.host === value;
                const select = () => {
                  if (active) return;
                  updateApi({ host: value });
                  // 服务正在运行时换监听地址必须重启才生效
                  if (api.enabled) {
                    void sendToSidecar({ action: "stop_api" });
                    setTimeout(() => startApi(value), 200);
                  }
                };
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={select}
                    className={cn(
                      "flex items-start gap-2.5 rounded-lg border p-3 text-left transition-all",
                      active
                        ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                        : "border-border hover:border-primary/40 hover:bg-muted/50",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                        active ? "border-primary bg-primary" : "border-muted-foreground/40",
                      )}
                    >
                      {active && <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />}
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        {t(locale, titleKey)}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">{t(locale, descKey)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">{t(locale, "api.service.port")}</label>
            <Input
              type="number"
              className="w-40"
              value={api.port}
              min={1024}
              max={65535}
              onChange={(e) => updateApi({ port: Number(e.target.value) || 9870 })}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t(locale, "api.service.apiKey")}</label>
            <Input
              type="password"
              className="w-80"
              placeholder={t(locale, "api.service.keyPlaceholder")}
              value={api.apiKey}
              onChange={(e) => updateApi({ apiKey: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t(locale, "api.service.keyHint")}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (sub === "endpoint-status") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t(locale, "api.endpoints.title")}</CardTitle>
          <CardDescription>{t(locale, "api.endpoints.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <EndpointLight label="POST /v1/audio/transcriptions (ASR)" online={api.endpoints?.asr ?? false} />
          <EndpointLight label="POST /v1/audio/speech (TTS)" online={api.endpoints?.tts ?? false} />
        </CardContent>
      </Card>
    );
  }

  // console
  const baseUrl = `http://${api.host}:${api.port}`;
  const asrCurl = `curl -X POST ${baseUrl}/v1/audio/transcriptions \\
  -H "Authorization: Bearer ${api.apiKey || "<api_key>"}" \\
  -F file=@test.wav \\
  -F model=qwen3-asr`;
  const ttsCurl = `curl -X POST ${baseUrl}/v1/audio/speech \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${api.apiKey || "<api_key>"}" \\
  -d '{"model":"qwen-tts","input":"你好世界","voice":"default"}' \\
  --output speech.mp3`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "api.console.title")}</CardTitle>
        <CardDescription>{t(locale, "api.console.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t(locale, "api.console.asr")}</span>
            <CopyButton text={asrCurl} />
          </div>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed">{asrCurl}</pre>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t(locale, "api.console.tts")}</span>
            <CopyButton text={ttsCurl} />
          </div>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed">{ttsCurl}</pre>
        </div>
      </CardContent>
    </Card>
  );
}
