import { useCallback, useEffect, useState } from "react";
import { FileText, Loader2, Mic, Play, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ModelSelector } from "@/components/ModelSelector";
import { ModelStatusBadge } from "@/components/ModelStatusBadge";
import { useAppStore } from "@/stores/app";
import { t } from "@/lib/i18n";
import { rustListTtsVoices, rustSetTtsLanguage, rustSynthesize } from "@/lib/tauri";
import { loadTtsModel } from "@/lib/modelLoader";
import { useExportDir } from "@/lib/useExportDir";

// ============================================================
// 模型与设备子页面
// ============================================================

function ModelDevicePage() {
  const tts = useAppStore((s) => s.tts);
  const gpu = useAppStore((s) => s.gpu);
  const ttsModelStatus = useAppStore((s) => s.ttsModelStatus);
  const locale = useAppStore((s) => s.locale);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t(locale, "tts.device")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Select
            value={tts.device}
            onValueChange={(device) => {
              void loadTtsModel(tts.model, device);
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t(locale, "tts.model")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ModelSelector
            kind="tts"
            selected={tts.model}
            onSelect={(name) => {
              void loadTtsModel(name, tts.device);
            }}
          />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t(locale, "tts.current")}: </span>
            <ModelStatusBadge status={ttsModelStatus} modelName={tts.model} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// 音色设置子页面
// ============================================================

const VOICES: { value: string; labelKey: string; descKey: string }[] = [
  { value: "default", labelKey: "tts.voice.default", descKey: "tts.voice.defaultDesc" },
  { value: "female-gentle", labelKey: "tts.voice.female", descKey: "tts.voice.femaleDesc" },
  { value: "male-mature", labelKey: "tts.voice.male", descKey: "tts.voice.maleDesc" },
];

function VoiceSettingsPage() {
  const locale = useAppStore((s) => s.locale);
  const tts = useAppStore((s) => s.tts);
  const updateTts = useAppStore((s) => s.updateTts);

  return (
    <div className="space-y-4">
      {/* 预设音色 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t(locale, "tts.voice.preset")}</CardTitle>
          <CardDescription>{t(locale, "tts.voice.presetDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {VOICES.map((v) => (
            <div
              key={v.value}
              className={`flex items-center justify-between rounded-lg border p-3 cursor-pointer transition-colors ${
                tts.voice === v.value ? "border-primary bg-primary/5" : "hover:bg-muted/50"
              }`}
              onClick={() => updateTts({ voice: v.value })}
            >
              <div className="flex items-center gap-3">
                <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${
                  tts.voice === v.value ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30"
                }`}>
                  {tts.voice === v.value && <span className="h-2 w-2 rounded-full bg-current" />}
                </span>
                <div>
                  <span className="text-sm font-medium">{t(locale, v.labelKey)}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{t(locale, v.descKey)}</span>
                </div>
              </div>
              {tts.voice === v.value && <Badge>{t(locale, "tts.current")}</Badge>}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 语速 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t(locale, "tts.speedLabel")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <span className="text-xs text-muted-foreground">0.5x</span>
            <Slider
              value={[tts.rate]}
              min={0.5}
              max={2.0}
              step={0.05}
              onValueChange={([rate]) => updateTts({ rate })}
              className="flex-1"
            />
            <span className="text-xs text-muted-foreground">2.0x</span>
            <span className="w-12 text-right text-sm tabular-nums font-medium">{tts.rate.toFixed(2)}x</span>
          </div>
        </CardContent>
      </Card>

      {/* 克隆音色（预留） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t(locale, "tts.voice.clone")}</CardTitle>
          <CardDescription>{t(locale, "tts.voice.cloneDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Button variant="outline" disabled>
              <Mic className="mr-2 h-4 w-4" />
              {t(locale, "tts.voice.record")}
            </Button>
            <Button variant="outline" disabled>
              <FileText className="mr-2 h-4 w-4" />
              {t(locale, "tts.voice.upload")}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t(locale, "tts.voice.comingSoon")}</p>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// 文字转语音子页面（合成 + 任务列表）
// ============================================================

function LanguageSelector() {
  const language = useAppStore((s) => s.tts.language);
  const updateTts = useAppStore((s) => s.updateTts);
  const [langs, setLangs] = useState<string[]>([]);
  const [voicesByLang, setVoicesByLang] = useState<Record<string, string[]>>({});
  useEffect(() => {
    void rustListTtsVoices().then((r) => {
      const langs = (r.languages as string[]) ?? [];
      const voicesByLang = (r.voices_by_lang as Record<string, string[]>) ?? {};
      const def = (r.default_lang as string) ?? "en";
      setLangs(langs);
      setVoicesByLang(voicesByLang);
      // store 默认 "zh" 可能与模型实际可用语言不符：同步到 Rust 默认语言并让引擎一致
      const cur = useAppStore.getState().tts.language;
      if (langs.length && !langs.includes(cur)) {
        useAppStore.getState().updateTts({ language: def });
        void rustSetTtsLanguage(def).catch(() => {
          useAppStore.getState().addLog(`[tts] switch language failed: ${def}`, "error");
        });
      }
    }).catch(() => {});
  }, []);
  // 固定英文显示，不跟随软件 locale 切换（用户要求）
  const langLabel: Record<string, string> = {
    zh: "Chinese",
    en: "English",
    ja: "Japanese",
  };
  const options = langs.length ? langs : ["zh", "en"];
  return (
    <Select value={language} onValueChange={(v) => {
        updateTts({ language: v });
        void rustSetTtsLanguage(v).catch(() => {
          useAppStore.getState().addLog(`[tts] switch language failed: ${v}`, "error");
        });
        const nextVoices = (voicesByLang[v] ?? []) as string[];
        const curVoice = useAppStore.getState().tts.voice;
        const curOk = nextVoices.length === 0 || nextVoices.includes(curVoice) || curVoice === "default";
        if (!curOk && nextVoices.length) {
          const mapped = nextVoices[0] === "af" ? "default" : nextVoices[0];
          updateTts({ voice: mapped });
        }
      }}>
      <SelectTrigger className="h-8 w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((l) => (
          <SelectItem key={l} value={l}>{langLabel[l] ?? l}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SynthesizePage() {
  const locale = useAppStore((s) => s.locale);
  const tts = useAppStore((s) => s.tts);
  const ttsModelStatus = useAppStore((s) => s.ttsModelStatus);
  const tasks = useAppStore((s) => s.ttsTasks);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  // 共享导出目录（与 ASR 转写共用一份）
  const { exportDir, setExportDir } = useExportDir();

  const browseDir = useCallback(async () => {
    const picked = await import("@tauri-apps/plugin-dialog").then((m) =>
      m.open({ directory: true, multiple: false, title: t(locale, "common.selectDir"), defaultPath: exportDir || undefined })
    );
    if (picked && typeof picked === "string") setExportDir(picked);
  }, [exportDir, setExportDir]);

  // 合成
  async function doSynthesize() {
    const trimmed = text.trim();
    if (!trimmed) return;
    const st = useAppStore.getState();

    st.addLog(`[synthesize] start: "${trimmed.slice(0, 40)}" voice=${tts.voice} rate=${tts.rate} dir=${exportDir || "-"}`, "info");
    st.addTtsTask({
      text: trimmed,
      voice: tts.voice,
      rate: tts.rate,
      status: "synthesizing",
    });
    // addTtsTask 之后从 store 重新取任务 id（避免闭包里 store.ttsTasks 快照滞后导致回写不到，从而一直转圈）
    const taskId = useAppStore.getState().ttsTasks[useAppStore.getState().ttsTasks.length - 1]?.id ?? 0;
    setText("");
    setBusy(true);

    // Rust 原生引擎：直接调用 Tauri invoke
      try {
        const result = await rustSynthesize(trimmed, tts.voice, tts.rate, exportDir);
        const cur = useAppStore.getState();
        cur.addLog(`[synthesize] done: ${result.saved_path as string} duration=${String(result.duration as unknown as string)} size=${String(result.size as unknown as string)}`, "success");
        if (taskId) {
          cur.updateTtsTask(taskId, {
            status: "done",
            savedPath: String((result as { saved_path?: string }).saved_path || ""),
            duration: Number((result as { duration?: number }).duration) || undefined,
            fileSize: String((result as { size?: string }).size || ""),
          });
        }
      } catch (e) {
        const cur = useAppStore.getState();
        const msg = String(e);
        cur.addLog(`[synthesize] failed: ${msg}`, "error");
        if (taskId) {
          cur.updateTtsTask(taskId, { status: "error", error: msg });
        }
      }
  }

  // 检查 busy 状态
  useEffect(() => {
    if (!busy) return;
    if (tasks.every((t) => t.status !== "synthesizing")) setBusy(false);
  }, [tasks, busy]);

  // 播放
  function playAudio(task: typeof tasks[0]) {
    if (!task.savedPath) return;
    import("@tauri-apps/plugin-opener").then((m) => m.openPath(task.savedPath!)).catch(() => {});
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-1 p-4">
          <div className="flex h-10 items-center gap-4">
            <span className="w-20 shrink-0 text-sm font-medium">Model</span>
            <div className="flex flex-1 items-center">
              <ModelStatusBadge status={ttsModelStatus} modelName={tts.model} />
            </div>
          </div>
          <div className="flex h-10 items-center gap-4">
            <span className="w-20 shrink-0 text-sm font-medium">Language</span>
            <div className="flex flex-1 items-center">
              <LanguageSelector />
            </div>
          </div>
          <div className="flex h-10 items-center gap-4">
            <span className="w-20 shrink-0 text-sm font-medium">Voice</span>
            <div className="flex flex-1 items-center gap-2 text-sm">
              <span>{t(locale, VOICES.find((v) => v.value === tts.voice)?.labelKey ?? "tts.voice.default")}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{tts.rate.toFixed(2)}x</span>
            </div>
          </div>
          <div className="flex h-10 items-center gap-4">
            <span className="w-20 shrink-0 text-sm font-medium">Export</span>
            <div className="flex flex-1 items-center gap-2">
              <span className="flex-1 truncate rounded-md border bg-muted px-3 py-1.5 text-xs font-mono">{exportDir || t(locale, "tts.exportDir.empty")}</span>
              <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={() => void browseDir()}>
                {t(locale, "tts.browse")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 输入区 */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t(locale, "tts.inputPlaceholder")}
            className="min-h-[100px]"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void doSynthesize(); }}
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t(locale, "tts.voiceLabel")}: {t(locale, VOICES.find((v) => v.value === tts.voice)?.descKey ?? "tts.voice.default")}</span>
              <span>·</span>
              <span>{t(locale, "tts.speedLabel")} {tts.rate.toFixed(2)}x</span>
            </div>
            <Button size="sm" onClick={() => void doSynthesize()} disabled={!text.trim() || busy}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
              {t(locale, "tts.synthesize")}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{t(locale, "tts.shortcutHint")}</p>
        </CardContent>
      </Card>

      {/* 任务列表 */}
      {tasks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t(locale, "tts.taskList")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-[400px]">
              <div className="space-y-2">
                {[...tasks].reverse().map((task) => (
                  <div key={task.id} className="rounded-lg border p-3 space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm flex-1 line-clamp-2">{task.text}</p>
                      <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => useAppStore.getState().removeTtsTask(task.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{t(locale, VOICES.find((v) => v.value === task.voice)?.descKey ?? "tts.voice.default")}</span>
                      <span>·</span>
                      <span>{task.rate}x</span>
                      {task.duration != null && <><span>·</span><span>{task.duration}s</span></>}
                      {task.fileSize && <><span>·</span><span>{task.fileSize}</span></>}
                      {task.status === "synthesizing" && (
                        <Badge variant="secondary" className="gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" /> {t(locale, "tts.synthesizing")}
                        </Badge>
                      )}
                      {task.status === "error" && (
                        <Badge variant="destructive">{task.error}</Badge>
                      )}
                      {task.status === "done" && (
                        <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => playAudio(task)}>
                          <Play className="h-3 w-3" />
                          {t(locale, "tts.play")}
                        </Button>
                      )}
                    </div>
                    {task.savedPath && (
                      <p className="text-[11px] text-emerald-600 dark:text-emerald-400 truncate" title={task.savedPath}>
                        ✓ {t(locale, "tts.saved")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ============================================================
// 主入口
// ============================================================

export function TtsPanel() {
  const sub = useAppStore((s) => s.activeSubMenu);

  if (sub === "model-device") {
    return <ModelDevicePage />;
  }

  if (sub === "voice-settings") {
    return <VoiceSettingsPage />;
  }

  // synthesize
  return <SynthesizePage />;
}
