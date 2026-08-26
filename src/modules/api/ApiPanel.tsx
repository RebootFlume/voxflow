import { useState } from "react";
import { Check, Copy, Globe, Lock } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";
import { sendToSidecar } from "@/lib/tauri";

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

          {/* 监听地址 */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t(locale, "api.service.host")}</label>
            <Select
              value={api.host}
              onValueChange={(v) => {
                updateApi({ host: v });
                // 如果服务正在运行，切换地址需要重启
                if (api.enabled) {
                  void sendToSidecar({ action: "stop_api" });
                  setTimeout(() => startApi(v), 200);
                }
              }}
            >
              <SelectTrigger className="w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="127.0.0.1">
                  <div className="flex items-center gap-2">
                    <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                    <div>
                      <div className="text-sm">{t(locale, "api.service.host.localhost")}</div>
                      <div className="text-[11px] text-muted-foreground">{t(locale, "api.service.host.localhost.desc")}</div>
                    </div>
                  </div>
                </SelectItem>
                <SelectItem value="0.0.0.0">
                  <div className="flex items-center gap-2">
                    <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                    <div>
                      <div className="text-sm">{t(locale, "api.service.host.lan")}</div>
                      <div className="text-[11px] text-muted-foreground">{t(locale, "api.service.host.lan.desc")}</div>
                    </div>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
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
