import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ModelSelector } from "@/components/ModelSelector";
import { ModelStatusBadge } from "@/components/ModelStatusBadge";
import { useAppStore, type ModelFramework } from "@/stores";
import { VolumeWave } from "@/components/VolumeWave";
import { t } from "@/lib/i18n";
import { sendToSidecar } from "@/lib/tauri";
import { loadAsrModel } from "@/lib/modelLoader";
import { rustGetVramStatus } from "@/lib/tauri";
import { TranscribePanel } from "./TranscribePanel";


const STATUS_KEYS: Record<string, string> = {
  idle: "asr.status.idle",
  recording: "asr.status.recording",
  recognizing: "asr.status.recognizing",
  done: "asr.status.done",
  error: "asr.status.error",
};

function InputDeviceDisplay() {
  const locale = useAppStore((s) => s.locale);
  const deviceName = useAppStore((s) => s.audioDevices.currentName);

  return (
    <span className="text-sm text-muted-foreground">
      {t(locale, "asr.inputDevice.label")}：{deviceName}
    </span>
  );
}

function HotkeyRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false);
  const locale = useAppStore((s) => s.locale);
  const inputRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={inputRef}
      tabIndex={0}
      onClick={() => { setRecording(true); inputRef.current?.focus(); }}
      onKeyDown={(e) => {
        if (!recording) return;
        e.preventDefault();
        e.stopPropagation();
        const key = e.key === " " ? "Space" : e.key;
        const combo = [e.altKey && "Alt", e.ctrlKey && "Ctrl", e.shiftKey && "Shift", key]
          .filter(Boolean)
          .join("+");
        onChange(combo);
        setRecording(false);
        inputRef.current?.blur();
      }}
      onBlur={() => setRecording(false)}
      className="flex h-9 w-64 cursor-pointer items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium transition-colors hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {recording ? t(locale, "asr.hotkey.pressKey") : value}
    </div>
  );
}

/** 显存监控卡片：总显存 + 已用 + 各框架占用 + 录音状态 */
function VramMonitorCard() {
  const locale = useAppStore((s) => s.locale);
  const asr = useAppStore((s) => s.asr);
  const [vram, setVram] = useState<{ total: number; used: number; llama: number | null; sherpa: number | null } | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      rustGetVramStatus().then((r) => {
        if (!alive) return;
        setVram({
          total: r.total_mb ?? 0,
          used: r.used_mb ?? 0,
          llama: r.frameworks?.llama?.mb ?? null,
          sherpa: r.frameworks?.sherpa?.mb ?? null,
        });
      }).catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, 3000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const pct = vram && vram.total > 0 ? Math.round((vram.used / vram.total) * 100) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t(locale, "asr.vram.title")}</CardTitle>
        <CardDescription>{t(locale, "asr.vram.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 录音状态 */}
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{t(locale, "asr.status.current")}</span>
          <Badge variant={asr.status === "recording" ? "default" : asr.status === "error" ? "destructive" : "secondary"}>
            {t(locale, STATUS_KEYS[asr.status])}
          </Badge>
          <VolumeWave volume={asr.volume} active={asr.status === "recording"} />
        </div>

        {/* 显存 */}
        {vram && vram.total > 0 ? (
          <>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t(locale, "asr.vram.usage")}</span>
              <span className="tabular-nums">
                {(vram.used / 1024).toFixed(1)} / {(vram.total / 1024).toFixed(1)} GB ({pct}%)
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : "bg-emerald-500"}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            <div className="space-y-1 text-xs text-muted-foreground">
              {vram.llama != null && (
                <div className="flex justify-between">
                  <span>llama-server</span>
                  <span className="tabular-nums">≈{(vram.llama / 1024).toFixed(2)} GB</span>
                </div>
              )}
              {vram.sherpa != null && (
                <div className="flex justify-between">
                  <span>sherpa-onnx</span>
                  <span className="tabular-nums">≈{(vram.sherpa / 1024).toFixed(2)} GB</span>
                </div>
              )}
              {vram.llama == null && vram.sherpa == null && (
                <p className="text-xs text-muted-foreground/70">{t(locale, "asr.vram.noDetail")}</p>
              )}
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{t(locale, "asr.vram.noGpu")}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function AsrPanel() {
  const sub = useAppStore((s) => s.activeSubMenu);
  const asr = useAppStore((s) => s.asr);
  const updateAsr = useAppStore((s) => s.updateAsr);
  const locale = useAppStore((s) => s.locale);
  const gpu = useAppStore((s) => s.gpu);

  if (sub === "hotkey") {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>{t(locale, "asr.hotkey.title")}</CardTitle>
            <CardDescription>{t(locale, "asr.hotkey.desc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t(locale, "asr.hotkey.label")}</label>
              <HotkeyRecorder
                value={asr.hotkey}
                onChange={(hotkey) => {
                  updateAsr({ hotkey });
                  useAppStore.getState().addLog(`[settings] ⌨ 录音热键已设为 ${hotkey}`, "info");
                }}
              />
              <p className="text-xs text-muted-foreground">{t(locale, "asr.hotkey.hint")}</p>
            </div>
            <Button variant="outline" onClick={() => updateAsr({ hotkey: "CapsLock" })}>
              {t(locale, "common.resetDefault")}
            </Button>
          </CardContent>
        </Card>

        <VramMonitorCard />
      </div>
    );
  }

  if (sub === "model") {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t(locale, "asr.device.label")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Select
              value={asr.device}
              onValueChange={(device) => {
                void loadAsrModel(asr.model, device);
              }}
            >
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cpu">CPU</SelectItem>
                <SelectItem value="cuda" disabled={!gpu.available}>
                  CUDA GPU{gpu.available && gpu.name ? ` (${gpu.name})` : ` (${t(locale, "common.notDetected")})`}
                </SelectItem>
              </SelectContent>
            </Select>
            <InputDeviceDisplay />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t(locale, "asr.model.label")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* 推理框架选择器 */}
            <div className="flex items-center gap-3">
              <label className="shrink-0 text-sm font-medium">{t(locale, "asr.framework.label")}</label>
              <Select
                value={asr.framework}
                onValueChange={(v) => {
                  const fw = v as ModelFramework;
                  updateAsr({ framework: fw });
                  // 切换框架时，如果当前模型不匹配新框架，不自动卸载，只提示用户
                  void sendToSidecar({ action: "set_asr_framework", framework: fw });
                }}
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gguf">{t(locale, "asr.framework.gguf")}</SelectItem>
                  <SelectItem value="onnx">{t(locale, "asr.framework.onnx")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* 当前已加载模型提示 */}
            {asr.modelStatus === "ready" && (
              <div className="rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-sky-700 dark:text-sky-400">
                {t(locale, "asr.framework.loaded", {
                  model: asr.model,
                  framework: asr.framework.toUpperCase(),
                })}
                <span className="ml-2 text-muted-foreground">
                  {t(locale, "asr.framework.switchHint")}
                </span>
              </div>
            )}

            {/* 模型选择器：只展示已下载 + 匹配当前框架的模型 */}
            <ModelSelector
              kind="asr"
              selected={asr.model}
              formatFilter={asr.framework}
              downloadedOnly
              onSelect={(model) => {
                void loadAsrModel(model, asr.device);
              }}
            />
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t(locale, "common.current")}: </span>
              <ModelStatusBadge status={asr.modelStatus} modelName={asr.model} />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (sub === "transcribe") {
    return <TranscribePanel />;
  }

  // status
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t(locale, "asr.status.title")}</CardTitle>
          <CardDescription>{t(locale, "asr.status.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{t(locale, "asr.status.current")}</span>
            <Badge
              variant={asr.status === "recording" ? "default" : asr.status === "error" ? "destructive" : "secondary"}
            >
              {t(locale, STATUS_KEYS[asr.status])}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {t(locale, "asr.status.device")}
              {asr.device.toUpperCase()}
            </span>
          </div>
          <VolumeWave volume={asr.volume} active={asr.status === "recording"} />
        </CardContent>
      </Card>
    </div>
  );
}
