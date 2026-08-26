import { useCallback, useEffect, useState } from "react";
import { Loader2, Mic, Play, Sparkles, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ModelSelector } from "@/components/ModelSelector";
import { ModelStatusBadge } from "@/components/ModelStatusBadge";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";
import { rustListE2eTtsModels, rustListTtsSpeakers, rustListTtsVoices, rustSetTtsCloneVoice, rustClearTtsCloneVoice, rustSetTtsLanguage, rustSynthesize } from "@/lib/tauri";
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

function VoiceSettingsPage() {
  const locale = useAppStore((s) => s.locale);
  const tts = useAppStore((s) => s.tts);
  const ttsClone = useAppStore((s) => s.ttsClone);
  const updateTts = useAppStore((s) => s.updateTts);
  const updateTtsClone = useAppStore((s) => s.updateTtsClone);
  const [speakers, setSpeakers] = useState<{ sid: number; name: string }[]>([]);
  const [numSpeakers, setNumSpeakers] = useState(0);

  // 加载模型的说话人列表
  useEffect(() => {
    void rustListTtsSpeakers().then((r) => {
      setSpeakers(r.speakers ?? []);
      setNumSpeakers(r.num_speakers ?? 0);
    }).catch(() => {});
  }, [tts.model]);

  const isCloningModel = /^(zipvoice|pocket)/i.test(tts.model);

  async function handlePickAudio() {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const picked = await dialog.open({
      multiple: false,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "ogg", "m4a"] }],
      title: t(locale, "tts.voice.clone.pickAudio"),
    });
    if (picked && typeof picked === "string") {
      updateTtsClone({ audioPath: picked, status: "idle", error: "" });
    }
  }

  async function handleApplyClone() {
    const { audioPath, referenceText } = useAppStore.getState().ttsClone;
    if (!audioPath) return;
    updateTtsClone({ status: "setting" });
    try {
      await rustSetTtsCloneVoice(audioPath, referenceText);
      updateTtsClone({ active: true, status: "ok" });
    } catch (e) {
      updateTtsClone({ status: "error", error: String(e) });
    }
  }

  async function handleClearClone() {
    try {
      await rustClearTtsCloneVoice();
    } catch { /* ignore */ }
    updateTtsClone({ active: false, audioPath: "", referenceText: "", status: "idle", error: "" });
  }

  return (
    <div className="space-y-4">
      {/* 预设音色 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t(locale, "tts.voice.preset")}</CardTitle>
          <CardDescription>
            {numSpeakers > 0
              ? `${numSpeakers} ${t(locale, "tts.voice.speakersAvailable")}`
              : t(locale, "tts.voice.presetDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {speakers.length > 0 ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
              {speakers.map((sp) => {
                const selected = tts.voice === String(sp.sid);
                return (
                  <button
                    key={sp.sid}
                    className={`rounded-lg border px-3 py-2 text-left transition-all ${
                      selected
                        ? "border-primary bg-primary/10 ring-1 ring-primary/20"
                        : "border-border hover:border-primary/40 hover:bg-muted/50"
                    }`}
                    onClick={() => {
                      updateTts({ voice: String(sp.sid) });
                      if (ttsClone.active) handleClearClone();
                    }}
                  >
                    <span className={`block text-sm font-medium leading-tight truncate ${
                      selected ? "text-primary" : ""
                    }`}>{sp.name}</span>
                    <span className="block text-[10px] text-muted-foreground mt-0.5">sid {sp.sid}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t(locale, "tts.voice.noSpeakers")}</p>
          )}
          {numSpeakers > 1 && (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t">
              <span className="text-xs text-muted-foreground">sid:</span>
              <Input
                type="number"
                min={0}
                max={numSpeakers - 1}
                value={tts.voice}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const v = e.target.value;
                  if (v !== "") updateTts({ voice: v });
                }}
                className="h-8 w-20 text-xs"
              />
              <span className="text-xs text-muted-foreground">/ {numSpeakers - 1}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 语音克隆（仅 ZipVoice / PocketTts 模型显示） */}
      {isCloningModel && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              {t(locale, "tts.voice.clone")}
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">{t(locale, "tts.voice.clone.supported")}</Badge>
            </CardTitle>
            <CardDescription>{t(locale, "tts.voice.cloneDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {ttsClone.active && (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                <Sparkles className="h-3.5 w-3.5" />
                {t(locale, "tts.voice.clone.active")}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void handlePickAudio()}>
                <Mic className="mr-2 h-4 w-4" />
                {t(locale, "tts.voice.clone.pickAudio")}
              </Button>
              {ttsClone.audioPath && (
                <span className="flex-1 truncate text-xs text-muted-foreground" title={ttsClone.audioPath}>
                  {ttsClone.audioPath.split(/[\\/]/).pop()}
                </span>
              )}
            </div>
            {ttsClone.audioPath && (
              <Input
                value={ttsClone.referenceText}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateTtsClone({ referenceText: e.target.value, status: "idle", error: "" })}
                placeholder={t(locale, "tts.voice.clone.placeholder")}
                className="h-8 text-xs"
              />
            )}
            {ttsClone.audioPath && ttsClone.referenceText.trim() && (
              <div className="flex items-center gap-2">
                <Button size="sm" className="h-8" disabled={ttsClone.status === "setting"} onClick={() => void handleApplyClone()}>
                  {ttsClone.status === "setting" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                  {t(locale, "tts.voice.clone.apply")}
                </Button>
                {ttsClone.active && (
                  <Button variant="ghost" size="sm" className="h-8" onClick={() => void handleClearClone()}>
                    {t(locale, "tts.voice.clone.clear")}
                  </Button>
                )}
              </div>
            )}
            {ttsClone.status === "error" && ttsClone.error && (
              <p className="text-xs text-destructive">{ttsClone.error}</p>
            )}
            <p className="text-[11px] text-muted-foreground">{t(locale, "tts.voice.clone.hint")}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ============================================================
// 文字转语音子页面（合成 + 任务列表）
// ============================================================

// 固定英文显示，不跟随软件 locale 切换（用户要求）
const langLabel: Record<string, string> = {
  zh: "Chinese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  fr: "French",
  de: "German",
  es: "Spanish",
  ru: "Russian",
  ar: "Arabic",
  vi: "Vietnamese",
};

function LanguageSelector() {
  const locale = useAppStore((s) => s.locale);
  const language = useAppStore((s) => s.tts.language);
  const ttsModel = useAppStore((s) => s.tts.model);
  const updateTts = useAppStore((s) => s.updateTts);
  const [langs, setLangs] = useState<string[]>([]);
  const [voicesByLang, setVoicesByLang] = useState<Record<string, string[]>>({});
  const [modelMode, setModelMode] = useState<
    "auto" | "fixed" | "select" | "cloning" | null
  >(null);
  useEffect(() => {
    // 从注册表查当前模型的 language_mode（id 匹配：忽略大小写和 -/_）
    void rustListE2eTtsModels().then((r) => {
      const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
      const hit = (r.models ?? []).find(
        (m) => norm(m.id) === norm(ttsModel) || norm(m.name) === norm(ttsModel),
      );
      if (hit) setModelMode(hit.language_mode);
    }).catch(() => {});
  }, [ttsModel]);
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
  // 自动识别模式（如 Kokoro 中英混合）→ 不显示语言选择，改为提示
  if (modelMode === "auto") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1 text-xs text-emerald-600 dark:text-emerald-400">
        <Sparkles className="h-3.5 w-3.5" />
        {t(locale, "tts.languageAuto")}
      </span>
    );
  }
  // 单语言固定（Kokoro-en / Kitten / Matcha-zh）→ 显示固定语言标记
  if (modelMode === "fixed") {
    const fixedLang = langs.length === 1 ? langs[0] : "en";
    return (
      <span className="inline-flex items-center rounded-md border border-border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground">
        {langLabel[fixedLang] ?? fixedLang}
      </span>
    );
  }
  // 语音克隆（ZipVoice / PocketTTS）→ 提示需要参考音频
  if (modelMode === "cloning") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1 text-xs text-amber-600 dark:text-amber-400">
        <Mic className="h-3.5 w-3.5" />
        {t(locale, "tts.languageCloning")}
      </span>
    );
  }
  // 默认 / select 模式（Supertonic 等）→ 显示语言下拉
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

    st.addLog(`[synthesize] start: "${trimmed.slice(0, 40)}" voice=${tts.voice} dir=${exportDir || "-"}`, "info");
    st.addTtsTask({
      text: trimmed,
      voice: tts.voice,
      status: "synthesizing",
    });
    // addTtsTask 之后从 store 重新取任务 id（避免闭包里 store.ttsTasks 快照滞后导致回写不到，从而一直转圈）
    const taskId = useAppStore.getState().ttsTasks[useAppStore.getState().ttsTasks.length - 1]?.id ?? 0;
    setText("");
    setBusy(true);

    // Rust 原生引擎：直接调用 Tauri invoke
      try {
        const result = await rustSynthesize(trimmed, tts.voice, exportDir);
        const cur = useAppStore.getState();
        cur.addLog(`[synthesize] done: ${result.saved_path as string} size=${String(result.size as unknown as string)}`, "success");
        if (taskId) {
          cur.updateTtsTask(taskId, {
            status: "done",
            savedPath: String((result as { saved_path?: string }).saved_path || ""),
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
              <span>{tts.voice ? `sid ${tts.voice}` : t(locale, "tts.voice.default")}</span>
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
              <span>{t(locale, "tts.voiceLabel")}: sid {tts.voice}</span>
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
                      <span>sid {task.voice}</span>
                      <span>·</span>
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
