import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileAudio, Loader2, Mic, Play, Sparkles, Trash2 } from "lucide-react";
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
import {
  openPath,
  rustListTtsSpeakers,
  rustSetTtsCloneVoice,
  rustClearTtsCloneVoice,
  rustSetTtsLanguage,
  rustSynthesize,
  rustRecordTtsReference,
} from "@/lib/tauri";
import { runtimeKeyOf } from "@/lib/modelState";
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
  const updateTts = useAppStore((s) => s.updateTts);
  const modelItems = useAppStore((s) => s.models.items);
  const runtimePackages = useAppStore((s) => s.runtime.packages);

  // 框架下拉项：TTS 模型清单里的运行时包 key 去重（顺序 = 清单顺序，确定性）；
  // label 优先取运行时包名，无包则直接用 key —— 目前只有 sherpa 一项也照常显示，接入新框架无需改前端
  const frameworkOptions: { key: string; label: string }[] = [];
  const seenKeys = new Set<string>();
  for (const m of modelItems) {
    if (m.kind !== "tts") continue;
    const key = runtimeKeyOf(m);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    frameworkOptions.push({ key, label: runtimePackages?.find((p) => p.framework === key)?.name ?? key });
  }
  // 当前选中值不在清单里（清单未到/模型已下架）→ 补一项，避免选择框空白
  if (tts.framework && !seenKeys.has(tts.framework)) {
    const pkg = runtimePackages?.find((p) => p.framework === tts.framework);
    frameworkOptions.unshift({ key: tts.framework, label: pkg?.name ?? tts.framework });
  }

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
          {/* 推理框架（运行时包 key）：TTS 模型统一由它加载，切换即改变后续加载路由 */}
          <div className="flex items-center gap-3">
            <label className="shrink-0 text-sm font-medium">{t(locale, "tts.framework.label")}</label>
            <Select value={tts.framework} onValueChange={(framework) => updateTts({ framework })}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {frameworkOptions.map((o) => (
                  <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(locale, "tts.framework.hint", { framework: tts.framework })}
          </p>
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

// 录音时长（秒）：Rust 侧钳制到 3–30
const RECORD_SECONDS = 6;

/** 音色名自带语言后缀（如 "alloy (EN)" / "zf_xiaobei (ZH)"）→ 取分组用的语言标签，无后缀返回 "" */
function voiceLangTag(name: string): string {
  return name.match(/\(([A-Za-z]{2,3})\)\s*$/)?.[1]?.toUpperCase() ?? "";
}

function VoiceSettingsPage() {
  const locale = useAppStore((s) => s.locale);
  const tts = useAppStore((s) => s.tts);
  const ttsClone = useAppStore((s) => s.ttsClone);
  const updateTts = useAppStore((s) => s.updateTts);
  const updateTtsClone = useAppStore((s) => s.updateTtsClone);
  const modelItems = useAppStore((s) => s.models.items);
  const [speakers, setSpeakers] = useState<{ sid: number; name: string }[]>([]);
  const [numSpeakers, setNumSpeakers] = useState(0);
  /** 试听：合成中标志（局部态，与任务列表解耦）+ 失败信息 */
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  /** 录音倒计时（>0 = 录制中） */
  const [recordLeft, setRecordLeft] = useState(0);
  const [recordError, setRecordError] = useState("");
  const [recordSilent, setRecordSilent] = useState(false);
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 音色筛选（语言后缀分组 + 名称搜索） */
  const [voiceQuery, setVoiceQuery] = useState("");
  const [voiceLang, setVoiceLang] = useState("");
  // 试听合成到共享导出目录（与合成页同一份）
  const { exportDir } = useExportDir();

  // 音色控件由描述符能力字段驱动（决策 A：models.items 单一来源），不再由 numSpeakers>1 派生嗅探。
  // vm 缺失（旧 payload / 未声明能力）→ 各开关退回既有行为（等价 preset 路径 + supports_clone 兜底）。
  const info = useTtsModelInfo(tts.model);
  const vm = info?.voice_mode;
  const mode = vm?.type;
  const cloneActive = ttsClone.active;
  /** 未选中/清单里找不到模型 → 两张卡片都引导「先加载模型」，不再整块隐藏 */
  const noModel = !info;
  /** Fixed（单音色）：隐藏音色遍历/网格，改为固定音色名文本。
   *  vm 缺失（旧 payload）时按方案 §4.2 的兜底判定：无克隆能力且音色数 ≤1 → 视为单音色模型。 */
  const fixedVoice = mode === "fixed" || (vm === undefined && info?.supports_clone === false && numSpeakers <= 1);
  /** 克隆能力：能力字段优先（clone / preset_and_clone），旧 payload 退回 supports_clone */
  const cloneCapable = !!info && (mode === "clone" || mode === "preset_and_clone" || info.supports_clone === true);
  /** Clone + overrides_preset：克隆激活后隐藏 sid 控件（不是禁用） */
  const sidHidden = mode === "clone" && cloneActive && vm?.overrides_preset === true;
  /** PresetAndClone：克隆激活时 sid 控件禁用（保留可见） */
  const sidDisabled = mode === "preset_and_clone" && cloneActive;
  /** per_language（sid 按语言独立，如 Supertonic）：语言切换后重新拉取音色列表 */
  const speakerLangDep = vm?.per_language === true ? tts.language : "";
  /** requires_text 缺省（旧 payload / 未声明）→ 保持必填 */
  const requiresText = vm?.requires_text !== false;
  const canApplyClone = !!ttsClone.audioPath && (!requiresText || ttsClone.referenceText.trim().length > 0);
  /** 试听用 voice：单音色模型没有可切换 sid，直接用模型第一个音色 */
  const previewVoice = fixedVoice && speakers.length > 0 ? String(speakers[0].sid) : tts.voice;
  const canPreview = !!tts.model && (speakers.length > 0 || cloneActive);
  /** 试听文本跟随合成语言（不是 UI locale） */
  const sampleText = t(locale, tts.language === "zh" ? "tts.preview.sample.zh" : "tts.preview.sample.en");

  /** 清单里支持克隆的 TTS 模型（当前模型不支持时用于引导切换） */
  const cloneModels = useMemo(
    () => modelItems.filter((m) => m.kind === "tts" && m.supports_clone === true),
    [modelItems],
  );

  const voiceLangs = useMemo(() => {
    const langs = new Set<string>();
    for (const sp of speakers) {
      const tag = voiceLangTag(sp.name);
      if (tag) langs.add(tag);
    }
    return [...langs];
  }, [speakers]);
  const shownSpeakers = useMemo(() => {
    const q = voiceQuery.trim().toLowerCase();
    return speakers.filter((sp) => {
      if (voiceLang && voiceLangTag(sp.name) !== voiceLang) return false;
      return !q || sp.name.toLowerCase().includes(q);
    });
  }, [speakers, voiceQuery, voiceLang]);
  /** 音色多（Kokoro 36 个等）或存在语言分组时才给筛选控件，避免少音色模型噪音 */
  const showFilter = !fixedVoice && (speakers.length > 12 || voiceLangs.length > 1);

  /** sid 越界（如持久化 voice="47" 但该模型只有 0..35）→ 高亮提示 + 一键改为第一个音色。
   *  "default" 是引擎默认值哨兵，不算越界。 */
  const voiceOutOfRange =
    !noModel &&
    !fixedVoice &&
    speakers.length > 0 &&
    tts.voice !== "" &&
    tts.voice !== "default" &&
    !speakers.some((sp) => String(sp.sid) === tts.voice);
  const sidMin = speakers.length > 0 ? Math.min(...speakers.map((sp) => sp.sid)) : 0;
  const sidMax = speakers.length > 0 ? Math.max(...speakers.map((sp) => sp.sid)) : 0;

  // 加载模型的说话人列表（per_language 模型随语言变化重新请求）
  useEffect(() => {
    void rustListTtsSpeakers().then((r) => {
      setSpeakers(r.speakers ?? []);
      setNumSpeakers(r.num_speakers ?? 0);
    }).catch(() => {});
  }, [tts.model, speakerLangDep]);

  // 卸载时清掉录音倒计时
  useEffect(() => () => {
    clearInterval(recordTimer.current ?? 0);
  }, []);

  function goModelManager() {
    const s = useAppStore.getState();
    s.setActiveModule("models");
    s.setActiveSubMenu("tts");
  }

  async function handlePickAudio() {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const picked = await dialog.open({
      multiple: false,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "ogg", "m4a"] }],
      title: t(locale, "tts.voice.clone.pickAudio"),
    });
    if (picked && typeof picked === "string") {
      setRecordSilent(false);
      updateTtsClone({ audioPath: picked, status: "idle", error: "" });
    }
  }

  /** 录音：录制固定时长，成功后写回 audioPath；peak < 0.01 视为没录到声音 */
  async function handleRecord() {
    if (recordLeft > 0) return;
    setRecordError("");
    setRecordSilent(false);
    setRecordLeft(RECORD_SECONDS);
    recordTimer.current = setInterval(() => setRecordLeft((s) => (s <= 1 ? 0 : s - 1)), 1000);
    try {
      const r = await rustRecordTtsReference(RECORD_SECONDS);
      updateTtsClone({ audioPath: r.path, status: "idle", error: "" });
      setRecordSilent(r.peak < 0.01);
    } catch (e) {
      setRecordError(String(e));
    } finally {
      if (recordTimer.current) clearInterval(recordTimer.current);
      recordTimer.current = null;
      setRecordLeft(0);
    }
  }

  /** 试听：合成到导出目录后用系统默认播放器打开（与任务列表 playAudio 同一条路径） */
  async function handlePreview(voice: string) {
    if (previewBusy) return;
    setPreviewBusy(true);
    setPreviewError("");
    try {
      const r = await rustSynthesize(sampleText, voice, exportDir);
      const saved = typeof r.saved_path === "string" ? r.saved_path : "";
      if (saved) await openPath(saved);
    } catch (e) {
      const msg = String(e);
      setPreviewError(msg);
      useAppStore.getState().addLog(`[tts] preview failed: ${msg}`, "error");
    } finally {
      setPreviewBusy(false);
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
      {/* 预设音色（常显：未加载模型 / 单音色模型时说明原因，不再整块隐藏） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t(locale, "tts.voice.preset")}</CardTitle>
          <CardDescription>
            {numSpeakers > 0
              ? `${numSpeakers} ${t(locale, "tts.voice.speakersAvailable")}`
              : t(locale, "tts.voice.presetDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {noModel ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">{t(locale, "tts.voice.needModel")}</p>
              <p className="text-xs text-muted-foreground">{t(locale, "tts.voice.needModelDesc")}</p>
              <Button variant="outline" size="sm" className="h-8" onClick={goModelManager}>
                {t(locale, "tts.gotoModels")}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={!canPreview || previewBusy}
                  onClick={() => void handlePreview(previewVoice)}
                >
                  {previewBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                  {t(locale, "tts.voice.previewCurrent")}
                </Button>
                {fixedVoice && (
                  <span className="text-xs text-muted-foreground">{t(locale, "tts.voice.fixedDesc")}</span>
                )}
              </div>
              {previewError && (
                <p className="text-xs text-destructive">{t(locale, "tts.voice.previewFailed", { msg: previewError })}</p>
              )}
              {/* sid 越界（持久化的 voice 不在当前模型音色列表里）→ 高亮 + 一键回到列表第一个音色 */}
              {voiceOutOfRange && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                  <span>{t(locale, "tts.voice.outOfRange", { min: sidMin, max: sidMax })}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => updateTts({ voice: String(speakers[0].sid) })}
                  >
                    {t(locale, "tts.voice.fixVoice")}
                  </Button>
                </div>
              )}
              {fixedVoice ? (
                // Fixed（单音色模型）：不渲染音色遍历，显示固定音色名 + 原因
                <p className="text-sm font-medium">{speakers[0]?.name ?? t(locale, "tts.voice.default")}</p>
              ) : speakers.length > 0 ? (
                <>
                  {/* 音色多时给筛选：语言后缀分组（Kokoro 类）+ 名称搜索 */}
                  {showFilter && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        value={voiceQuery}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setVoiceQuery(e.target.value)}
                        placeholder={t(locale, "tts.voice.search")}
                        className="h-8 w-48 text-xs"
                      />
                      {voiceLangs.length > 1 && (
                        <div className="flex flex-wrap items-center gap-1">
                          {["", ...voiceLangs].map((lang) => (
                            <button
                              key={lang || "all"}
                              className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                                voiceLang === lang
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "border-border text-muted-foreground hover:border-primary/40"
                              }`}
                              onClick={() => setVoiceLang(lang)}
                            >
                              {lang || t(locale, "tts.voice.filterAll")}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                    {shownSpeakers.map((sp) => {
                      const selected = tts.voice === String(sp.sid);
                      return (
                        <div key={sp.sid} className="relative">
                          <button
                            className={`w-full rounded-lg border px-3 py-2 pr-8 text-left transition-all ${
                              selected
                                ? "border-primary bg-primary/10 ring-1 ring-primary/20"
                                : "border-border hover:border-primary/40 hover:bg-muted/50"
                            }`}
                            onClick={() => {
                              updateTts({ voice: String(sp.sid) });
                              if (ttsClone.active) void handleClearClone();
                            }}
                          >
                            <span className={`block text-sm font-medium leading-tight truncate ${
                              selected ? "text-primary" : ""
                            }`}>{sp.name}</span>
                            <span className="block text-[10px] text-muted-foreground mt-0.5">sid {sp.sid}</span>
                          </button>
                          {/* 试听只挂在选中卡片上：36 个音色不必各挂一个播放任务 */}
                          {selected && (
                            <button
                              className="absolute right-1 top-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-primary disabled:opacity-50"
                              disabled={previewBusy}
                              title={t(locale, "tts.voice.preview")}
                              onClick={() => void handlePreview(String(sp.sid))}
                            >
                              {previewBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {shownSpeakers.length === 0 && (
                    <p className="text-xs text-muted-foreground">{t(locale, "tts.voice.noMatch")}</p>
                  )}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">{t(locale, "tts.voice.noSpeakers")}</p>
              )}
              {!fixedVoice && numSpeakers > 1 && !sidHidden && (
                <div className="flex items-center gap-2 pt-3 border-t">
                  <span className="text-xs text-muted-foreground">sid:</span>
                  <Input
                    type="number"
                    min={0}
                    max={numSpeakers - 1}
                    value={tts.voice}
                    disabled={sidDisabled}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      const v = e.target.value;
                      if (v !== "") updateTts({ voice: v });
                    }}
                    className="h-8 w-20 text-xs"
                  />
                  <span className="text-xs text-muted-foreground">/ {numSpeakers - 1}</span>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* 克隆音色（常显：不支持时说明原因并列出可切换模型，不再整块隐藏） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            {t(locale, "tts.voice.clone")}
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
              {cloneCapable ? t(locale, "tts.voice.clone.supported") : t(locale, "tts.voice.clone.unsupported")}
            </Badge>
          </CardTitle>
          <CardDescription>{t(locale, "tts.voice.cloneDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {noModel ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">{t(locale, "tts.voice.needModel")}</p>
              <p className="text-xs text-muted-foreground">{t(locale, "tts.voice.clone.needModel")}</p>
              <Button variant="outline" size="sm" className="h-8" onClick={goModelManager}>
                {t(locale, "tts.gotoModels")}
              </Button>
            </div>
          ) : !cloneCapable ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {t(locale, "tts.voice.clone.unsupportedTitle", { model: tts.model })}
              </p>
              <p className="text-xs text-muted-foreground">{t(locale, "tts.voice.clone.unsupportedDesc")}</p>
              {cloneModels.length > 0 ? (
                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">{t(locale, "tts.voice.clone.cloneModels")}</span>
                  {cloneModels.map((m) => (
                    <div key={m.name} className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-xs">{m.name}</span>
                      {m.state === "downloaded" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 shrink-0"
                          onClick={() => void loadTtsModel(m.name, tts.device)}
                        >
                          {t(locale, "tts.voice.clone.switch")}
                        </Button>
                      ) : (
                        <Button variant="ghost" size="sm" className="h-7 shrink-0" onClick={goModelManager}>
                          {t(locale, "tts.gotoModels")}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t(locale, "tts.voice.clone.noCloneModels")}</p>
              )}
            </div>
          ) : (
            <>
              {ttsClone.active && (
                <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                  <Sparkles className="h-3.5 w-3.5" />
                  {t(locale, "tts.voice.clone.active")}
                </div>
              )}
              {/* 参考音频来源：录音（6 秒）或本地文件 */}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void handleRecord()} disabled={recordLeft > 0}>
                  {recordLeft > 0 ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mic className="mr-2 h-4 w-4" />}
                  {recordLeft > 0
                    ? t(locale, "tts.voice.clone.recording", { left: recordLeft })
                    : t(locale, "tts.voice.record")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void handlePickAudio()}>
                  <FileAudio className="mr-2 h-4 w-4" />
                  {t(locale, "tts.voice.clone.pickAudio")}
                </Button>
                {ttsClone.audioPath && (
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={ttsClone.audioPath}>
                    {ttsClone.audioPath.split(/[\\/]/).pop()}
                  </span>
                )}
              </div>
              {recordSilent && (
                <p className="text-xs text-amber-600 dark:text-amber-400">{t(locale, "tts.voice.clone.recordSilent")}</p>
              )}
              {recordError && (
                <p className="text-xs text-destructive">
                  {t(locale, "tts.voice.clone.recordFailed", { msg: recordError })}
                </p>
              )}
              {ttsClone.audioPath && (
                <>
                  <Input
                    value={ttsClone.referenceText}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateTtsClone({ referenceText: e.target.value, status: "idle", error: "" })}
                    placeholder={t(locale, "tts.voice.clone.placeholder")}
                    className="h-8 text-xs"
                  />
                  {/* requires_text 由模型能力决定：false 时留空即可，true 时必须与音频一致 */}
                  <p className="text-[11px] text-muted-foreground">
                    {requiresText
                      ? t(locale, "tts.voice.clone.textRequired")
                      : t(locale, "tts.voice.clone.textOptional")}
                  </p>
                </>
              )}
              {ttsClone.audioPath && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    className="h-8"
                    disabled={ttsClone.status === "setting" || !canApplyClone}
                    onClick={() => void handleApplyClone()}
                  >
                    {ttsClone.status === "setting" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                    {t(locale, "tts.voice.clone.apply")}
                  </Button>
                  {ttsClone.active && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        disabled={previewBusy || !tts.model}
                        onClick={() => void handlePreview(previewVoice)}
                      >
                        {previewBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
                        {t(locale, "tts.voice.clone.preview")}
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8" onClick={() => void handleClearClone()}>
                        {t(locale, "tts.voice.clone.clear")}
                      </Button>
                    </>
                  )}
                </div>
              )}
              {previewError && (
                <p className="text-xs text-destructive">{t(locale, "tts.voice.previewFailed", { msg: previewError })}</p>
              )}
              {ttsClone.status === "error" && ttsClone.error && (
                <p className="text-xs text-destructive">{ttsClone.error}</p>
              )}
              <p className="text-[11px] text-muted-foreground">{t(locale, "tts.voice.clone.hint")}</p>
            </>
          )}
        </CardContent>
      </Card>
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

/**
 * 当前 TTS 模型的描述符能力（语言 / 音色模式 / 克隆）。
 * 数据源 = models.items（models_state 事件携带能力字段，决策 A 单一来源）。
 * 归一化匹配：展示名 / 引擎目录名，与 Rust 侧 spec::find 的别名集合一致。
 */
function useTtsModelInfo(model: string) {
  const items = useAppStore((s) => s.models.items);
  return useMemo(() => {
    if (!model) return null;
    const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
    return (
      items.find(
        (m) => m.kind === "tts" && (norm(m.name) === norm(model) || norm(m.path) === norm(model)),
      ) ?? null
    );
  }, [items, model]);
}

function LanguageSelector() {
  const locale = useAppStore((s) => s.locale);
  const language = useAppStore((s) => s.tts.language);
  const ttsModel = useAppStore((s) => s.tts.model);
  const updateTts = useAppStore((s) => s.updateTts);
  const info = useTtsModelInfo(ttsModel);

  // 语言对齐：当前语言不在模型支持列表 → 切到模型默认（zh 优先，否则首个支持语言）
  const langs = info?.languages ?? [];
  useEffect(() => {
    if (!info || langs.length === 0) return;
    const cur = useAppStore.getState().tts.language;
    if (!langs.includes(cur)) {
      const def = langs.includes("zh") ? "zh" : langs[0];
      updateTts({ language: def });
      void rustSetTtsLanguage(def).catch(() => {
        useAppStore.getState().addLog(`[tts] switch language failed: ${def}`, "error");
      });
    }
  }, [info, langs, updateTts]);

  if (!info) return null;
  // 自动识别模式（如 Kokoro 中英混合）→ 不显示语言选择，改为提示
  if (info.language_mode === "auto") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1 text-xs text-emerald-600 dark:text-emerald-400">
        <Sparkles className="h-3.5 w-3.5" />
        {t(locale, "tts.languageAuto")}
      </span>
    );
  }
  // 单语言固定（Kokoro-en / Kitten / Matcha-zh）→ 显示固定语言标记（来自描述符）
  if (info.language_mode === "fixed") {
    const fixedLang = langs[0] ?? "en";
    return (
      <span className="inline-flex items-center rounded-md border border-border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground">
        {langLabel[fixedLang] ?? fixedLang}
      </span>
    );
  }
  // 语音克隆（ZipVoice）→ 提示需要参考音频
  if (info.language_mode === "cloning") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1 text-xs text-amber-600 dark:text-amber-400">
        <Mic className="h-3.5 w-3.5" />
        {t(locale, "tts.languageCloning")}
      </span>
    );
  }
  // select 模式（Supertonic 31 语言等）→ 显示语言下拉（选项来自描述符）
  return (
    <Select
      value={language}
      onValueChange={(v) => {
        updateTts({ language: v });
        void rustSetTtsLanguage(v).catch(() => {
          useAppStore.getState().addLog(`[tts] switch language failed: ${v}`, "error");
        });
      }}
    >
      <SelectTrigger className="h-8 w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {langs.map((l) => (
          <SelectItem key={l} value={l}>
            {langLabel[l] ?? l}
          </SelectItem>
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
