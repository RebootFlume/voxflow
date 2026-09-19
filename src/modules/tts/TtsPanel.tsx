import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileAudio, Info, Loader2, Mic, Pencil, Play, Sparkles, Trash2, Volume2, X, type LucideIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { ModelSelector } from "@/components/ModelSelector";
import { ModelStatusBadge } from "@/components/ModelStatusBadge";
import { useAppStore, type TtsTask } from "@/stores";
import { t, type Locale } from "@/lib/i18n";
import type { TtsVoiceMode } from "@/stores/slices/ttsSlice";
import {
  rustListTtsSpeakers,
  rustClearTtsCloneVoice,
  rustSetTtsLanguage,
  rustSynthesize,
  rustCancelTts,
  rustRecordTtsReference,
  rustTranscribeLlama,
  rustTtsVoicesList,
  rustTtsVoiceAdd,
  rustTtsVoiceUpdate,
  rustTtsVoiceRemove,
  rustTtsVoiceUse,
  type TtsVoiceItem,
} from "@/lib/tauri";
import { runtimeKeyOf, supportsClone, ttsModelInfoOf } from "@/lib/modelState";
import { useAudioPreview } from "@/lib/useAudioPreview";
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

// ============================================================
// 音色库：克隆工作区（两个新增入口 + 平铺网格 + 模态框表单）
// ============================================================

/** 顶层模式入口（始终可见，不因模型能力隐藏） */
const VOICE_MODE_TABS: { key: TtsVoiceMode; icon: LucideIcon; labelKey: string }[] = [
  { key: "preset", icon: Volume2, labelKey: "tts.voice.mode.preset" },
  { key: "clone", icon: Mic, labelKey: "tts.voice.mode.clone" },
];

/** 音色来源：录音 / 本机音频文件（工作区里只有这两个新增入口，命名都在模态框内完成） */
type VoiceSource = "record" | "file";

/** 新增草稿（模态框状态）：取消即丢弃，不入库 */
interface VoiceDraft {
  kind: "add";
  source: VoiceSource;
  /** 录音/选文件成功后才有值；空串 = 还没拿到音频 */
  sourcePath: string;
  name: string;
  note: string;
  referenceText: string;
}

/** 编辑条目（同一个模态框）：只改名称/说明/参考文本，音频不变 */
interface VoiceEdit {
  kind: "edit";
  id: string;
  originalName: string;
  name: string;
  note: string;
  referenceText: string;
}

type VoiceModalState = VoiceDraft | VoiceEdit;

interface VoiceLibraryApi {
  voices: TtsVoiceItem[];
  /** 当前生效条目：Rust 的 active_id 与「克隆已下发」两者一致才算（失败不得谎报生效） */
  selectedVoice: TtsVoiceItem | null;
  error: string;
  busyId: string;
  /** 刚保存的条目（短暂高亮，不做自动应用） */
  flashId: string;
  confirmDelId: string;
  setConfirmDelId: (id: string) => void;
  modal: VoiceModalState | null;
  formBusy: boolean;
  formError: string;
  transcribeBusy: boolean;
  transcribeMsg: string;
  /** 模态框内录音状态 */
  recordLeft: number;
  recordSilent: boolean;
  recordError: string;
  openRecordModal: () => void;
  openUploadModal: () => Promise<void>;
  openEditModal: (v: TtsVoiceItem) => void;
  closeModal: () => void;
  patchModal: (patch: { name?: string; note?: string; referenceText?: string }) => void;
  startRecording: () => Promise<void>;
  transcribe: () => Promise<void>;
  saveModal: () => Promise<void>;
  applyVoice: (v: TtsVoiceItem) => Promise<void>;
  removeVoice: (v: TtsVoiceItem) => Promise<void>;
}

/** 音色库状态机：清单 / 当前生效 / 新增与编辑模态框 / 应用 / 删除（克隆工作区使用） */
function useVoiceLibrary(): VoiceLibraryApi {
  const locale = useAppStore((s) => s.locale);
  const cloneActive = useAppStore((s) => s.ttsClone.active);
  const updateTtsClone = useAppStore((s) => s.updateTtsClone);
  const [voices, setVoices] = useState<TtsVoiceItem[]>([]);
  const [activeVoiceId, setActiveVoiceId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [flashId, setFlashId] = useState("");
  const [confirmDelId, setConfirmDelId] = useState("");
  const [modal, setModal] = useState<VoiceModalState | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [transcribeBusy, setTranscribeBusy] = useState(false);
  const [transcribeMsg, setTranscribeMsg] = useState("");
  const [recordLeft, setRecordLeft] = useState(0);
  const [recordSilent, setRecordSilent] = useState(false);
  const [recordError, setRecordError] = useState("");
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 挂载即拉取；之后每次入库/删除/应用后刷新，active_id 是生效态权威来源
  const refresh = useCallback(async () => {
    try {
      const r = await rustTtsVoicesList();
      setVoices(r.voices ?? []);
      setActiveVoiceId(r.active_id ?? null);
      setError("");
      return r;
    } catch (e) {
      setError(t(locale, "tts.voice.lib.loadFailed", { msg: String(e) }));
      return null;
    }
  }, [locale]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 卸载时清掉录音倒计时与高亮计时器
  useEffect(() => () => {
    clearInterval(recordTimer.current ?? 0);
    clearTimeout(flashTimer.current ?? 0);
  }, []);

  const selectedVoiceId = cloneActive ? activeVoiceId : null;
  const selectedVoice = voices.find((v) => v.id === selectedVoiceId) ?? null;

  /** 重置模态框（含框内录音态）；保存成功后也走这里。不动 flashId：它的 2.6s 计时器自行收尾 */
  function resetModal() {
    clearInterval(recordTimer.current ?? 0);
    recordTimer.current = null;
    setModal(null);
    setFormBusy(false);
    setFormError("");
    setTranscribeBusy(false);
    setTranscribeMsg("");
    setRecordLeft(0);
    setRecordSilent(false);
    setRecordError("");
  }

  function closeModal() {
    if (formBusy) return;
    resetModal();
  }

  /** 保存后短暂高亮新条目（不自动应用：用哪条由用户点「使用」决定） */
  function flash(id: string) {
    clearTimeout(flashTimer.current ?? 0);
    setFlashId(id);
    flashTimer.current = setTimeout(() => setFlashId(""), 2600);
  }

  /** 应用条目：下发引擎 → 成功才刷新（active_id 变更）并同步 ttsClone；失败只报错，不标记生效 */
  async function applyVoice(v: TtsVoiceItem) {
    setBusyId(v.id);
    setError("");
    updateTtsClone({ status: "setting", error: "" });
    try {
      await rustTtsVoiceUse(v.id);
      updateTtsClone({
        active: true,
        name: v.name,
        audioPath: v.audio_path,
        referenceText: v.reference_text,
        status: "ok",
        error: "",
      });
      await refresh();
    } catch (e) {
      const msg = String(e);
      updateTtsClone({ status: "error", error: msg });
      useAppStore.getState().addLog(`[tts] 应用音色失败: ${msg}`, "error");
      setError(t(locale, "tts.voice.lib.useFailed", { msg }));
    } finally {
      setBusyId("");
    }
  }

  function openRecordModal() {
    resetModal();
    setModal({ kind: "add", source: "record", sourcePath: "", name: "", note: "", referenceText: "" });
  }

  /** 上传入口：先弹系统文件选择，选中后带着文件打开模态框（少一次点击） */
  async function openUploadModal() {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const picked = await dialog.open({
      multiple: false,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "ogg", "m4a"] }],
      title: t(locale, "tts.voice.add.uploadTitle"),
    });
    if (!picked || typeof picked !== "string") return;
    resetModal();
    setModal({ kind: "add", source: "file", sourcePath: picked, name: "", note: "", referenceText: "" });
  }

  function openEditModal(v: TtsVoiceItem) {
    resetModal();
    setModal({ kind: "edit", id: v.id, originalName: v.name, name: v.name, note: v.note, referenceText: v.reference_text });
  }

  function patchModal(patch: { name?: string; note?: string; referenceText?: string }) {
    setModal((m) => (m ? { ...m, ...patch } : m));
  }

  /** 框内录音：录制固定时长，成功后回填 sourcePath；peak < 0.01 视为没录到声音（提示重录） */
  async function startRecording() {
    if (recordLeft > 0) return;
    setRecordError("");
    setRecordSilent(false);
    setRecordLeft(RECORD_SECONDS);
    recordTimer.current = setInterval(() => setRecordLeft((s) => (s <= 1 ? 0 : s - 1)), 1000);
    try {
      const r = await rustRecordTtsReference(RECORD_SECONDS);
      const peak = r.peak;
      setModal((m) => (m && m.kind === "add" ? { ...m, sourcePath: r.path } : m));
      setRecordSilent(peak < 0.01);
    } catch (e) {
      setRecordError(String(e));
    } finally {
      clearInterval(recordTimer.current ?? 0);
      recordTimer.current = null;
      setRecordLeft(0);
    }
  }

  /** 自动转写参考文本（复用 llama-server ASR；首次会加载 ASR 模型，较慢；失败不阻断保存） */
  async function transcribe() {
    if (transcribeBusy || !modal || modal.kind !== "add" || !modal.sourcePath) return;
    const sourcePath = modal.sourcePath;
    setTranscribeBusy(true);
    setTranscribeMsg("");
    try {
      const r = await rustTranscribeLlama(sourcePath);
      const text = (r.text ?? "").trim();
      if (text) setModal((m) => (m && m.kind === "add" ? { ...m, referenceText: text } : m));
      else setTranscribeMsg(t(locale, "tts.voice.add.transcribeEmpty"));
    } catch (e) {
      setTranscribeMsg(t(locale, "tts.voice.add.transcribeFailed", { msg: String(e) }));
    } finally {
      setTranscribeBusy(false);
    }
  }

  /** 保存：新增入库（不自动应用，只高亮）/ 编辑保存（改的是生效条目时重新下发，引擎参数跟上） */
  async function saveModal() {
    if (!modal) return;
    const name = modal.name.trim();
    if (!name) {
      setFormError(t(locale, "tts.voice.add.needName"));
      return;
    }
    if (modal.kind === "add" && !modal.sourcePath) {
      setFormError(t(locale, "tts.voice.modal.needSource"));
      return;
    }
    setFormBusy(true);
    setFormError("");
    if (modal.kind === "add") {
      try {
        const { id } = await rustTtsVoiceAdd(modal.sourcePath, name, modal.note.trim(), modal.referenceText.trim());
        await refresh();
        resetModal();
        flash(id);
      } catch (e) {
        setFormBusy(false);
        setFormError(t(locale, "tts.voice.add.saveFailed", { msg: String(e) }));
        useAppStore.getState().addLog(`[tts] 音色入库失败: ${String(e)}`, "error");
      }
      return;
    }
    const editedId = modal.id;
    const wasSelected = editedId === selectedVoiceId;
    try {
      await rustTtsVoiceUpdate(editedId, name, modal.note.trim(), modal.referenceText.trim());
      const list = await refresh();
      const updated = list?.voices.find((v) => v.id === editedId);
      resetModal();
      if (wasSelected && updated) await applyVoice(updated);
    } catch (e) {
      setFormBusy(false);
      setFormError(t(locale, "tts.voice.edit.failed", { msg: String(e) }));
    }
  }

  /** 删除（UI 二次确认）；删的是生效条目 → 连同引擎参数一起清掉，不留悬空引用 */
  async function removeVoice(v: TtsVoiceItem) {
    setConfirmDelId("");
    setError("");
    try {
      await rustTtsVoiceRemove(v.id);
    } catch (e) {
      setError(t(locale, "tts.voice.lib.removeFailed", { msg: String(e) }));
      return;
    }
    if (v.id === activeVoiceId) {
      try {
        await rustClearTtsCloneVoice();
      } catch { /* 引擎可能本来就没参数，忽略 */ }
      updateTtsClone({ active: false, audioPath: "", referenceText: "", status: "idle", error: "" });
    }
    if (modal?.kind === "edit" && modal.id === v.id) resetModal();
    await refresh();
  }

  return {
    voices,
    selectedVoice,
    error,
    busyId,
    flashId,
    confirmDelId,
    setConfirmDelId,
    modal,
    formBusy,
    formError,
    transcribeBusy,
    transcribeMsg,
    recordLeft,
    recordSilent,
    recordError,
    openRecordModal,
    openUploadModal,
    openEditModal,
    closeModal,
    patchModal,
    startRecording,
    transcribe,
    saveModal,
    applyVoice,
    removeVoice,
  };
}

/** created_ms → 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前），超过 30 天退回本地日期；无效返回 "" */
function formatRelativeTime(ms: number, locale: Locale): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const minutes = Math.floor((Date.now() - d.getTime()) / 60000);
  if (minutes < 0) return d.toLocaleDateString();
  if (minutes < 1) return t(locale, "tts.voice.lib.time.justNow");
  if (minutes < 60) return t(locale, "tts.voice.lib.time.minutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(locale, "tts.voice.lib.time.hours", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t(locale, "tts.voice.lib.time.days", { n: days });
  return d.toLocaleDateString();
}

interface VoiceModalProps {
  lib: VoiceLibraryApi;
  locale: Locale;
  requiresText: boolean;
}

/** 新增/编辑共用的模态框：来源回显 + 名称（必填）+ 说明 + 参考文本（可自动转写） */
function VoiceModal({ lib, locale, requiresText }: VoiceModalProps) {
  // Esc 关闭（保存中不关，避免半途丢弃）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") lib.closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lib]);

  const modal = lib.modal;
  if (!modal) return null;
  const isAdd = modal.kind === "add";
  const recording = lib.recordLeft > 0;
  const fileName = isAdd ? modal.sourcePath.split(/[\\/]/).pop() ?? "" : "";
  const sourceReady = !isAdd || modal.sourcePath !== "";
  const canSave = modal.name.trim() !== "" && sourceReady && !lib.formBusy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={lib.closeModal}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="max-h-full w-full max-w-lg space-y-3 overflow-y-auto rounded-lg border bg-card p-4 shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">
            {modal.kind === "edit"
              ? t(locale, "tts.voice.modal.title.edit", { name: modal.originalName })
              : t(locale, "tts.voice.modal.title.add")}
          </span>
          <Button variant="ghost" size="icon" className="h-6 w-6" disabled={lib.formBusy} onClick={lib.closeModal}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* 来源回显；录音来源在框内提供「开始录音」（6s 倒计时 + 静音提示） */}
        {isAdd && (
          <div className="space-y-2 rounded-md border p-3">
            <span className="block text-xs font-medium">{t(locale, "tts.voice.modal.source")}</span>
            {modal.source === "record" ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={recording}
                  onClick={() => void lib.startRecording()}
                >
                  {recording ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Mic className="mr-1.5 h-3.5 w-3.5" />}
                  {recording
                    ? t(locale, "tts.voice.add.recording", { left: lib.recordLeft })
                    : t(locale, "tts.voice.add.record")}
                </Button>
                {modal.sourcePath !== "" ? (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400">
                    {t(locale, "tts.voice.modal.recordDone", { file: fileName })}
                  </span>
                ) : (
                  !recording && (
                    <span className="text-[11px] text-muted-foreground">
                      {t(locale, "tts.voice.add.hint", { seconds: RECORD_SECONDS })}
                    </span>
                  )
                )}
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">{t(locale, "tts.voice.modal.file", { file: fileName })}</p>
                <p className="text-[11px] text-muted-foreground">{t(locale, "tts.voice.add.fileHint")}</p>
              </>
            )}
            {lib.recordSilent && (
              <p className="text-xs text-amber-600 dark:text-amber-400">{t(locale, "tts.voice.clone.recordSilent")}</p>
            )}
            {lib.recordError && (
              <p className="text-xs text-destructive">{t(locale, "tts.voice.clone.recordFailed", { msg: lib.recordError })}</p>
            )}
          </div>
        )}

        {sourceReady ? (
          <>
            <Input
              value={modal.name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => lib.patchModal({ name: e.target.value })}
              placeholder={t(locale, "tts.voice.add.namePlaceholder")}
              className="h-8 text-xs"
            />
            <Textarea
              value={modal.note}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => lib.patchModal({ note: e.target.value })}
              placeholder={t(locale, "tts.voice.add.notePlaceholder")}
              className="min-h-[52px] text-xs"
            />
            <div className="flex items-start gap-2">
              <Textarea
                value={modal.referenceText}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => lib.patchModal({ referenceText: e.target.value })}
                placeholder={t(locale, "tts.voice.clone.placeholder")}
                className="min-h-[52px] flex-1 text-xs"
              />
              {isAdd && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0"
                  disabled={lib.transcribeBusy}
                  onClick={() => void lib.transcribe()}
                >
                  {lib.transcribeBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1.5 h-3.5 w-3.5" />}
                  {t(locale, "tts.voice.add.transcribe")}
                </Button>
              )}
            </div>
            {isAdd && <p className="text-[11px] text-muted-foreground">{t(locale, "tts.voice.add.transcribeHint")}</p>}
            {lib.transcribeMsg && <p className="text-[11px] text-amber-600 dark:text-amber-400">{lib.transcribeMsg}</p>}
            {/* requires_text 由模型能力决定：false 时留空即可，true 时必须与音频一致 */}
            <p className="text-[11px] text-muted-foreground">
              {requiresText ? t(locale, "tts.voice.clone.textRequired") : t(locale, "tts.voice.clone.textOptional")}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" className="h-8" disabled={!canSave} onClick={() => void lib.saveModal()}>
                {lib.formBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {modal.kind === "edit" ? t(locale, "tts.voice.edit.save") : t(locale, "tts.voice.add.save")}
              </Button>
              <Button variant="ghost" size="sm" className="h-8" disabled={lib.formBusy} onClick={lib.closeModal}>
                {t(locale, "tts.voice.add.cancel")}
              </Button>
              {modal.name.trim() === "" && (
                <span className="text-[11px] text-muted-foreground">{t(locale, "tts.voice.add.nameRequired")}</span>
              )}
            </div>
            {lib.formError && <p className="text-xs text-destructive">{lib.formError}</p>}
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">{t(locale, "tts.voice.modal.needSource")}</p>
            <Button variant="ghost" size="sm" className="h-8" onClick={lib.closeModal}>
              {t(locale, "tts.voice.add.cancel")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

interface VoiceTileGridProps {
  lib: VoiceLibraryApi;
  locale: Locale;
}

/** 音色平铺网格：名称（主）+ 说明（次）+ 相对时间（弱）+ 试听/使用/编辑/删除，生效项高亮 */
function VoiceTileGrid({ lib, locale }: VoiceTileGridProps) {
  const audio = useAudioPreview();
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {audio.error && (
        <p className="col-span-full text-xs text-destructive">{audio.error}</p>
      )}
      {lib.voices.map((v) => {
        const selected = v.id === lib.selectedVoice?.id;
        const busy = lib.busyId === v.id;
        const justSaved = v.id === lib.flashId && !selected;
        return (
          <div
            key={v.id}
            className={`flex flex-col justify-between gap-2 rounded-lg border p-3 transition-colors ${
              selected ? "border-primary bg-primary/10" : justSaved ? "border-primary/60 ring-2 ring-primary/25" : "border-border"
            }`}
          >
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0">
                <span className={`block truncate text-sm font-medium ${selected ? "text-primary" : ""}`}>{v.name}</span>
                {v.note && (
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={v.note}>
                    {v.note}
                  </span>
                )}
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  {formatRelativeTime(v.created_ms, locale)}
                </span>
              </div>
              {selected ? (
                <Badge variant="outline" className="shrink-0 border-primary/40 px-1.5 py-0 text-[10px] text-primary">
                  {t(locale, "tts.voice.lib.selected")}
                </Badge>
              ) : justSaved ? (
                <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                  {t(locale, "tts.voice.lib.new")}
                </Badge>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={busy}
                title={
                  audio.playing === v.audio_path
                    ? t(locale, "tts.stop")
                    : t(locale, "tts.voice.lib.preview")
                }
                onClick={() => void audio.play(v.audio_path)}
              >
                <Play className="mr-1 h-3 w-3" />
                {audio.playing === v.audio_path
                  ? t(locale, "tts.stop")
                  : t(locale, "tts.voice.lib.preview")}
              </Button>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : (
                <Button
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  disabled={selected}
                  onClick={() => void lib.applyVoice(v)}
                >
                  {t(locale, "tts.voice.lib.use")}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                title={t(locale, "tts.voice.lib.edit")}
                onClick={() => lib.openEditModal(v)}
              >
                <Pencil className="h-3 w-3" />
              </Button>
              {lib.confirmDelId === v.id ? (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => void lib.removeVoice(v)}
                  >
                    {t(locale, "tts.voice.lib.deleteConfirm")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => lib.setConfirmDelId("")}
                  >
                    {t(locale, "tts.voice.lib.cancel")}
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive"
                  title={t(locale, "tts.voice.lib.delete")}
                  onClick={() => lib.setConfirmDelId(v.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function VoiceSettingsPage() {
  const locale = useAppStore((s) => s.locale);
  const tts = useAppStore((s) => s.tts);
  const ttsClone = useAppStore((s) => s.ttsClone);
  const updateTts = useAppStore((s) => s.updateTts);
  const updateTtsClone = useAppStore((s) => s.updateTtsClone);
  const { speakers, numSpeakers } = useTtsSpeakers();
  /** 试听：合成中标志（局部态，与任务列表解耦）+ 失败信息 */
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  /** 录音/新增/编辑都在模态框里，状态由 hook 自持 */
  const lib = useVoiceLibrary();
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
  /** 未选中/清单里找不到模型 → 对应工作区引导「先加载模型」 */
  const noModel = !info;
  /** Fixed（单音色）：隐藏音色遍历/网格，改为固定音色名文本。
   *  vm 缺失（旧 payload）时按方案 §4.2 的兜底判定：无克隆能力且音色数 ≤1 → 视为单音色模型。 */
  const fixedVoice = mode === "fixed" || (vm === undefined && info?.supports_clone === false && numSpeakers <= 1);
  /** 克隆能力：与「模型就绪恢复」同源（modelState.supportsClone） */
  const cloneCapable = supportsClone(info);
  /** 克隆入口门控：只有"能力明确为否"才拦截；能力**未知**（旧 payload 未声明能力）保持既有行为，
   *  不把"不知道"当成"不支持"（`vm === undefined && supports_clone === undefined` = 未知）。
   *  引擎侧 set_clone_voice 仍是最终兜底：门控只是不让人白做录音/命名。 */
  const cloneDeclared = vm !== undefined || info?.supports_clone !== undefined;
  const cloneBlocked = Boolean(info) && cloneDeclared && cloneCapable === false;
  // 模型换成不支持克隆的 ⇒ 自动退出克隆工作区（否则录音+命名做完，点「使用」才被引擎拒绝）
  useEffect(() => {
    if (cloneBlocked && tts.voiceMode === "clone") updateTts({ voiceMode: "preset" });
  }, [cloneBlocked, tts.voiceMode, updateTts]);
  /** Clone + overrides_preset：克隆激活后隐藏 sid 控件（不是禁用） */
  const sidHidden = mode === "clone" && cloneActive && vm?.overrides_preset === true;
  /** PresetAndClone：克隆激活时 sid 控件禁用（保留可见） */
  const sidDisabled = mode === "preset_and_clone" && cloneActive;
  /** requires_text 缺省（旧 payload / 未声明）→ 保持必填 */
  const requiresText = vm?.requires_text !== false;
  /** 试听用 voice：单音色模型没有可切换 sid，直接用模型第一个音色 */
  const previewVoice = fixedVoice && speakers.length > 0 ? String(speakers[0].sid) : tts.voice;
  const canPreview = !!tts.model && (speakers.length > 0 || cloneActive);
  /** 试听文本跟随合成语言（不是 UI locale） */
  const sampleText = t(locale, tts.language === "zh" ? "tts.preview.sample.zh" : "tts.preview.sample.en");


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
   *  空串 = 用模型默认音色；早前版本的 "default" 哨兵也一并放行（迁移期兼容）。 */
  const voiceOutOfRange =
    !noModel &&
    !fixedVoice &&
    speakers.length > 0 &&
    tts.voice !== "" &&
    tts.voice !== "default" &&
    !speakers.some((sp) => String(sp.sid) === tts.voice);
  const sidMin = speakers.length > 0 ? Math.min(...speakers.map((sp) => sp.sid)) : 0;
  const sidMax = speakers.length > 0 ? Math.max(...speakers.map((sp) => sp.sid)) : 0;


  // 卸载时清掉录音倒计时（录音计时器由 useVoiceLibrary 持有）
  function goModelManager() {
    const s = useAppStore.getState();
    s.setActiveModule("models");
    s.setActiveSubMenu("tts");
  }

  const audio = useAudioPreview();

  /** 试听当前音色：合成到导出目录后在应用内播放（与任务列表 playAudio 同一条路径） */
  async function handlePreview(voice: string) {
    if (previewBusy) return;
    setPreviewBusy(true);
    setPreviewError("");
    try {
      const r = await rustSynthesize(sampleText, voice, exportDir);
      const saved = typeof r.saved_path === "string" ? r.saved_path : "";
      if (saved) {
        const err = await audio.play(saved);
        if (err) setPreviewError(err);
      }
    } catch (e) {
      const msg = String(e);
      setPreviewError(msg);
      useAppStore.getState().addLog(`[tts] preview failed: ${msg}`, "error");
    } finally {
      setPreviewBusy(false);
    }
  }

  async function handleClearClone() {
    try {
      await rustClearTtsCloneVoice();
    } catch { /* ignore */ }
    updateTtsClone({ active: false, audioPath: "", referenceText: "", status: "idle", error: "" });
  }

  return (
    <div className="flex min-h-full flex-col gap-3">
      {/* 顶层两个同级入口：内置预设音色 / 克隆音色（始终可见，选中后整页 = 该工作区） */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 self-start rounded-lg border bg-card p-1">
        {VOICE_MODE_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = tts.voiceMode === tab.key;
          const blocked = tab.key === "clone" && cloneBlocked;
          return (
            <button
              key={tab.key}
              disabled={blocked}
              title={blocked ? t(locale, "tts.voice.cloneUnsupported") : undefined}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                active
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
              onClick={() => updateTts({ voiceMode: tab.key })}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(locale, tab.labelKey)}
            </button>
          );
        })}
        {cloneBlocked && (
          <span className="px-2 text-xs text-muted-foreground">
            {t(locale, "tts.voice.cloneUnsupported")}
          </span>
        )}
      </div>

      {tts.voiceMode !== "clone" ? (
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader>
            <CardTitle className="text-base">{t(locale, "tts.voice.preset")}</CardTitle>
            <CardDescription>
              {numSpeakers > 0
                ? `${numSpeakers} ${t(locale, "tts.voice.speakersAvailable")}`
                : t(locale, "tts.voice.presetDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 space-y-3 overflow-y-auto">
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
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {shownSpeakers.map((sp) => {
                      const selected = tts.voice === String(sp.sid);
                      return (
                        <div
                          key={sp.sid}
                          className={`flex items-center gap-2 rounded-lg border px-3 py-2 transition-all ${
                            selected
                              ? "border-primary bg-primary/10 ring-1 ring-primary/20"
                              : "border-border hover:border-primary/40"
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <span className={`block truncate text-sm font-medium leading-tight ${
                              selected ? "text-primary" : ""
                            }`}>{sp.name}</span>
                            <span className="mt-0.5 block text-[10px] text-muted-foreground">sid {sp.sid}</span>
                          </div>
                          {/* 条目动作显式分「试听」「应用」两个按钮（不做点一下即切换） */}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 shrink-0 px-2 text-[11px]"
                            disabled={previewBusy}
                            onClick={() => void handlePreview(String(sp.sid))}
                          >
                            {previewBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
                            {t(locale, "tts.voice.lib.preview")}
                          </Button>
                          {selected ? (
                            <Badge variant="outline" className="shrink-0 border-primary/40 px-1.5 py-0 text-[10px] text-primary">
                              {t(locale, "tts.voice.lib.selected")}
                            </Badge>
                          ) : (
                            <Button
                              size="sm"
                              className="h-6 shrink-0 px-2 text-[11px]"
                              onClick={() => {
                                updateTts({ voice: String(sp.sid) });
                                if (ttsClone.active) void handleClearClone();
                              }}
                            >
                              {t(locale, "tts.voice.lib.apply")}
                            </Button>
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
      ) : (
        <Card className="flex min-h-0 flex-1 flex-col">
          {/* 头部：标题 + 能力徽章 + 当前生效说明；有生效克隆时给「取消克隆」 */}
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 space-y-1.5">
                <CardTitle className="flex items-center gap-2 text-base">
                  {t(locale, "tts.voice.mode.clone")}
                  <Badge variant="outline" className="h-4 px-1.5 py-0 text-[10px]">
                    {cloneCapable ? t(locale, "tts.voice.clone.supported") : t(locale, "tts.voice.clone.unsupported")}
                  </Badge>
                </CardTitle>
                <CardDescription>{t(locale, "tts.voice.cloneDesc")}</CardDescription>
                {lib.selectedVoice && (
                  <p className="truncate text-[11px] text-emerald-600 dark:text-emerald-400">
                    {t(locale, "tts.voice.clone.active", { name: lib.selectedVoice.name })}
                  </p>
                )}
              </div>
              {/* 取消克隆：清掉引擎里的克隆参数，音色库条目保留 */}
              {cloneActive && (
                <Button variant="ghost" size="sm" className="h-7 shrink-0" onClick={() => void handleClearClone()}>
                  <X className="mr-1 h-3 w-3" />
                  {t(locale, "tts.voice.clone.cancel")}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
            {/* 两个新增入口：点了走模态框（录音 / 上传音频），工作区不再常驻控件 */}
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={!cloneCapable}
                onClick={lib.openRecordModal}
              >
                <Mic className="mr-1.5 h-3.5 w-3.5" />
                {t(locale, "tts.voice.action.record")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={!cloneCapable}
                onClick={() => void lib.openUploadModal()}
              >
                <FileAudio className="mr-1.5 h-3.5 w-3.5" />
                {t(locale, "tts.voice.action.upload")}
              </Button>
            </div>

            {/* 能力门控：**只占一行**（下面的音色平铺才是主体，别让提示吃掉高度）。
                不列"可切到哪些克隆模型"：用哪个模型由用户自己决定（后续接入 PyTorch 等更多引擎后
                更不该由这里替他选），这里只给状态 + 一个去模型页的入口。 */}
            {noModel ? (
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Info className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate">{t(locale, "tts.voice.needModel")}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-2 text-[11px]"
                  onClick={goModelManager}
                >
                  {t(locale, "tts.gotoModels")}
                </Button>
              </div>
            ) : !cloneCapable ? (
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Info className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate">
                  {t(locale, "tts.voice.clone.unsupportedTitle", { model: tts.model })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-2 text-[11px]"
                  onClick={goModelManager}
                >
                  {t(locale, "tts.gotoModels")}
                </Button>
              </div>
            ) : null}

            {lib.error && <p className="shrink-0 text-xs text-destructive">{lib.error}</p>}
            {ttsClone.status === "error" && ttsClone.error && (
              <p className="shrink-0 text-xs text-destructive">{ttsClone.error}</p>
            )}

            {/* 音色平铺：占满剩余高度 */}
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="flex shrink-0 items-baseline gap-2">
                <span className="text-xs font-medium">{t(locale, "tts.voice.lib.mine")}</span>
                <span className="text-[11px] text-muted-foreground">{lib.voices.length}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {lib.voices.length === 0 ? (
                  <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-1 text-center">
                    <p className="text-sm text-muted-foreground">{t(locale, "tts.voice.lib.empty")}</p>
                    <p className="text-[11px] text-muted-foreground">{t(locale, "tts.voice.lib.emptyHint")}</p>
                  </div>
                ) : (
                  <VoiceTileGrid lib={lib} locale={locale} />
                )}
              </div>
              <p className="shrink-0 text-[11px] text-muted-foreground">{t(locale, "tts.voice.clone.hint")}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 新增/编辑模态框（工作区只留两个入口 + 平铺） */}
      <VoiceModal lib={lib} locale={locale} requiresText={requiresText} />
    </div>
  );
}

// ============================================================
// 文字转语音子页面（合成 + 任务列表）
// ============================================================

// 固定英文显示，不跟随软件 locale 切换（用户要求）。
// 用内置 Intl.DisplayNames 而不是手写表：手写表只有 10 种，Supertonic 声明的 31 种里
// 有 22 种会漏成裸语言码（"bg"、"hr"、"et"…），而 Intl 覆盖全部 BCP-47 语言码。
const enLangNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    return null; // 老 WebView 不支持 → 退回语言码
  }
})();
function langLabel(code: string): string {
  try {
    return enLangNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * 当前 TTS 模型的描述符能力（语言 / 音色模式 / 克隆）。
 * 数据源 = models.items（models_state 事件携带能力字段，决策 A 单一来源）。
 * 归一化匹配：展示名 / 引擎目录名，与 Rust 侧 spec::find 的别名集合一致。
 */
function useTtsModelInfo(model: string) {
  const items = useAppStore((s) => s.models.items);
  return useMemo(() => ttsModelInfoOf(items, model), [items, model]);
}

/**
 * 当前模型的说话人列表（描述符驱动：`speakers.json` 优先，`per_language` 模型随语言重拉）。
 *
 * 音色网格与"音色"展示行共用这一份数据：两边各拉一次会出现名字与显示不一致（用户看到的
 * "音色 sid 45" 就是展示行没拿名字）。
 */
function useTtsSpeakers() {
  const model = useAppStore((s) => s.tts.model);
  const language = useAppStore((s) => s.tts.language);
  const info = useTtsModelInfo(model);
  const langDep = info?.voice_mode?.per_language === true ? language : "";
  const [speakers, setSpeakers] = useState<{ sid: number; name: string }[]>([]);
  const [numSpeakers, setNumSpeakers] = useState(0);

  useEffect(() => {
    void rustListTtsSpeakers()
      .then((r) => {
        setSpeakers(r.speakers ?? []);
        setNumSpeakers(r.num_speakers ?? 0);
      })
      .catch(() => {
        setSpeakers([]);
        setNumSpeakers(0);
      });
  }, [model, langDep]);

  return { speakers, numSpeakers };
}

function LanguageSelector() {
  const locale = useAppStore((s) => s.locale);
  const language = useAppStore((s) => s.tts.language);
  const ttsModel = useAppStore((s) => s.tts.model);
  const updateTts = useAppStore((s) => s.updateTts);
  const info = useTtsModelInfo(ttsModel);

  // 语言对齐：当前语言不在模型支持列表 → 切到模型默认（zh 优先 → en → 首个支持语言）。
  // 中间的 en 不能省：Supertonic 的 31 种语言里没有 zh，只按"zh 否则首项"会落到 `ar`
  // （阿拉伯语）——中文界面切过去莫名变成阿拉伯语。
  const langs = info?.languages ?? [];
  useEffect(() => {
    if (!info || langs.length === 0) return;
    const cur = useAppStore.getState().tts.language;
    if (!langs.includes(cur)) {
      const def = langs.includes("zh") ? "zh" : langs.includes("en") ? "en" : langs[0];
      updateTts({ language: def });
      void rustSetTtsLanguage(def).catch(() => {
        useAppStore.getState().addLog(`[tts] switch language failed: ${def}`, "error");
      });
    }
  }, [info, langs, updateTts]);

  // 未加载/未选中模型：不支持语言时不知道有哪些语言 ⇒ 不留空行，给一句"先加载模型"
  if (!info) {
    return <span className="text-xs text-muted-foreground">{t(locale, "tts.voice.needModel")}</span>;
  }
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
        {langLabel(fixedLang)}
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
            {langLabel(l)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SynthesizePage() {
  const locale = useAppStore((s) => s.locale);
  const tts = useAppStore((s) => s.tts);
  const ttsClone = useAppStore((s) => s.ttsClone);
  const ttsModelStatus = useAppStore((s) => s.ttsModelStatus);
  const tasks = useAppStore((s) => s.ttsTasks);
  const [text, setText] = useState("");
  /** 正在等 `rust_synthesize` 返回的任务 id：派发 effect 的去重锁（串行队列下最多一个在飞） */
  const inFlightRef = useRef<number | null>(null);
  /** 队列里还有未跑完的任务（只驱动按钮 spinner，不参与 disabled —— 合成中仍可继续排队） */
  const queued = tasks.some((t) => t.status === "pending" || t.status === "synthesizing");
  const audio = useAudioPreview();
  const { speakers } = useTtsSpeakers();
  /** 引擎是否就绪：两个信号取"或"——`engines.tts`（modelState 约定的权威字段）与旧徽章
   *  `ttsModelStatus`。二者都出自 sidecar 事件，而启动快照（status_snapshot）只同步 ASR，
   *  单看一个信号可能在"引擎已就绪但事件漏收"时把按钮永久禁掉 ⇒ 任一为就绪即允许。 */
  const ttsEngineReady = useAppStore((s) => s.engines.tts.status === "ready");
  const canSynth = ttsEngineReady || ttsModelStatus === "ready";
  /** 音色展示：**克隆生效时显示克隆音色名**（此时引擎用的是参考音频，sid 无关）；
   *  否则按 sid 去 `speakers.json` 查名字；两者都拿不到（未加载模型 / sid 不在当前列表）
   *  ⇒ 「默认音色」——不能把裸 sid 当成"当前音色"展示。 */
  const voiceText = (() => {
    if (ttsClone.active) return ttsClone.name || t(locale, "tts.voice.mode.clone");
    const name = speakers.find((s) => String(s.sid) === tts.voice)?.name;
    return name ? name + " · sid " + tts.voice : t(locale, "tts.voice.default");
  })();

  // 共享导出目录（与 ASR 转写共用一份）
  const { exportDir, setExportDir } = useExportDir();

  const browseDir = useCallback(async () => {
    const picked = await import("@tauri-apps/plugin-dialog").then((m) =>
      m.open({ directory: true, multiple: false, title: t(locale, "common.selectDir"), defaultPath: exportDir || undefined })
    );
    if (picked && typeof picked === "string") setExportDir(picked);
  }, [exportDir, setExportDir]);

  // 入队：只登记 pending 任务并清空输入（不 await），真正派发交给下面的串行派发 effect
  function enqueueSynthesize() {
    const trimmed = text.trim();
    if (!trimmed) return;
    const st = useAppStore.getState();
    st.addLog(`[synthesize] queued: "${trimmed.slice(0, 40)}" voice=${tts.voice} dir=${st.io.exportDir || "-"}`, "info");
    st.addTtsTask({ text: trimmed, voice: tts.voice, voiceLabel: voiceText, status: "pending" });
    setText("");
  }

  // 串行派发：没有 synthesizing 任务时取最早的 pending 发出去，一次只发一个 rust_synthesize。
  // inFlightRef 是去重锁——await 期间 tasks 变化会让本 effect 重跑，没锁就会对同一任务双发。
  useEffect(() => {
    const st = useAppStore.getState();
    if (inFlightRef.current !== null) return;
    if (st.ttsTasks.some((t) => t.status === "synthesizing")) return;
    const next = st.ttsTasks.find((t) => t.status === "pending");
    if (!next) return;

    inFlightRef.current = next.id;
    // 导出目录在派发时读：排队期间用户可能改目录，按"开始合成那一刻"的目录落盘
    const dir = st.io.exportDir;
    st.updateTtsTask(next.id, { status: "synthesizing" });
    st.addLog(`[synthesize] start: "${next.text.slice(0, 40)}" voice=${next.voice} dir=${dir || "-"}`, "info");
    void runTtsTask(next, dir);
  }, [tasks]);

  /** 跑一个已派发的任务并落终态；终态写入会改动 tasks ⇒ 上面的 effect 重跑并自动派下一个 */
  async function runTtsTask(task: TtsTask, dir: string) {
    try {
      const res = (await rustSynthesize(task.text, task.voice, dir)) as {
        saved_path?: string;
        size?: string;
        cancelled?: boolean;
      };
      const cur = useAppStore.getState();
      if (res.cancelled === true) {
        // 段边界取消：invoke 正常返回但没有产物 ⇒ 终态"已取消"
        cur.addLog(`[synthesize] cancelled: "${task.text.slice(0, 40)}"`, "warn");
        cur.updateTtsTask(task.id, { status: "cancelled", cancelling: false, progress: undefined });
      } else {
        cur.addLog(`[synthesize] done: ${String(res.saved_path || "")} size=${String(res.size || "")}`, "success");
        cur.updateTtsTask(task.id, {
          status: "done",
          cancelling: false,
          savedPath: String(res.saved_path || ""),
          fileSize: String(res.size || ""),
        });
      }
    } catch (e) {
      const cur = useAppStore.getState();
      const msg = String(e);
      cur.addLog(`[synthesize] failed: ${msg}`, "error");
      cur.updateTtsTask(task.id, { status: "error", error: msg, cancelling: false });
    } finally {
      inFlightRef.current = null;
    }
  }

  // 取消：排队中 = 本地直接置已取消（不发 IPC）；合成中 = 标记"取消中"并请求 Rust 段边界取消
  function cancelTask(task: TtsTask) {
    const st = useAppStore.getState();
    if (task.status === "pending") {
      st.updateTtsTask(task.id, { status: "cancelled" });
      st.addLog(`[synthesize] cancelled (queued): "${task.text.slice(0, 40)}"`, "info");
      return;
    }
    if (task.status !== "synthesizing" || task.cancelling) return;
    st.updateTtsTask(task.id, { cancelling: true });
    st.addLog(`[synthesize] cancel requested: "${task.text.slice(0, 40)}"`, "info");
    // Rust 取消是段边界生效（最多等当前一段跑完）⇒ 终态由 runTtsTask 在 invoke 返回时写入
    void rustCancelTts()
      .then((r) => {
        if (r.cancelled) return;
        const cur = useAppStore.getState();
        cur.addLog("[synthesize] cancel ignored: no active synthesis", "warn");
        // 合成恰好已结束（invoke 已返回）⇒ 撤销"取消中"，终态由 runTtsTask 写入
        if (cur.ttsTasks.find((t) => t.id === task.id)?.status === "synthesizing") {
          cur.updateTtsTask(task.id, { cancelling: false });
        }
      })
      .catch((e) => {
        const cur = useAppStore.getState();
        cur.addLog(`[synthesize] cancel failed: ${String(e)}`, "error");
        if (cur.ttsTasks.find((t) => t.id === task.id)?.status === "synthesizing") {
          cur.updateTtsTask(task.id, { cancelling: false });
        }
      });
  }

  // 播放（应用内，见 useAudioPreview）
  function playAudio(task: typeof tasks[0]) {
    if (!task.savedPath) return;
    void audio.play(task.savedPath).then((err) => {
      if (err) useAppStore.getState().addLog("[tts] 播放失败: " + err, "error");
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-1 p-4">
          <div className="flex h-10 items-center gap-4">
            <span className="w-20 shrink-0 text-sm font-medium">{t(locale, "tts.model")}</span>
            <div className="flex flex-1 items-center">
              <ModelStatusBadge status={ttsModelStatus} modelName={tts.model} />
            </div>
          </div>
          <div className="flex h-10 items-center gap-4">
            <span className="w-20 shrink-0 text-sm font-medium">{t(locale, "tts.language")}</span>
            <div className="flex flex-1 items-center">
              <LanguageSelector />
            </div>
          </div>
          <div className="flex h-10 items-center gap-4">
            <span className="w-20 shrink-0 text-sm font-medium">{t(locale, "tts.voice.label")}</span>
            <div className="flex flex-1 items-center gap-2 text-sm">
              <span>{voiceText}</span>
            </div>
          </div>
          <div className="flex h-10 items-center gap-4">
            <span className="w-20 shrink-0 text-sm font-medium">{t(locale, "tts.exportDir")}</span>
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
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) enqueueSynthesize(); }}
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {/* 空值 / 名字查不到 ⇒ 显示「默认音色」，不渲染成 "sid " */}
              <span>
                {t(locale, "tts.voiceLabel")}: {voiceText}
              </span>
            </div>
            {!canSynth && (
              <span className="text-[11px] text-muted-foreground">{t(locale, "tts.voice.needModel")}</span>
            )}
            <Button
              size="sm"
              onClick={enqueueSynthesize}
              disabled={text.trim() === "" || !canSynth}
            >
              {queued ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
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
                {[...tasks].reverse().map((task) => {
                  /** 分段进度百分比（chunk/chunks 与 sidecar 的 progress 同义，由段数自算避免两份来源漂移） */
                  const pct = task.progress ? Math.round((task.progress.chunk / task.progress.chunks) * 100) : 0;
                  return (
                    <div key={task.id} className="rounded-lg border p-3 space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm flex-1 line-clamp-2">{task.text}</p>
                        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => useAppStore.getState().removeTtsTask(task.id)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{task.voiceLabel ?? "sid " + task.voice}</span>
                        <span>·</span>
                        {task.fileSize && <><span>·</span><span>{task.fileSize}</span></>}
                        {task.status === "synthesizing" && (
                          <Badge variant="secondary" className="gap-1">
                            <Loader2 className="h-3 w-3 animate-spin" /> {t(locale, task.cancelling ? "tts.task.cancelling" : "tts.task.synthesizing")}
                          </Badge>
                        )}
                        {task.status === "pending" && (
                          <Badge variant="outline">{t(locale, "tts.task.pending")}</Badge>
                        )}
                        {task.status === "cancelled" && (
                          <Badge variant="outline">{t(locale, "tts.task.cancelled")}</Badge>
                        )}
                        {task.status === "error" && (
                          <Badge variant="destructive">{task.error || t(locale, "tts.task.error")}</Badge>
                        )}
                        {task.status === "done" && (
                          <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => playAudio(task)}>
                            <Play className="h-3 w-3" />
                            {audio.playing === task.savedPath ? t(locale, "tts.stop") : t(locale, "tts.play")}
                          </Button>
                        )}
                        {(task.status === "pending" || task.status === "synthesizing") && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2"
                            disabled={task.cancelling === true}
                            onClick={() => cancelTask(task)}
                          >
                            <X className="h-3 w-3" />
                            {t(locale, "tts.task.cancel")}
                          </Button>
                        )}
                      </div>
                      {task.status === "synthesizing" && task.progress && (
                        <div className="space-y-1">
                          <Progress value={pct} className="h-1.5" />
                          <div className="flex justify-between text-[11px] text-muted-foreground">
                            <span>{t(locale, "tts.task.progress", { chunk: task.progress.chunk, chunks: task.progress.chunks })}</span>
                            <span>{pct}%</span>
                          </div>
                        </div>
                      )}
                      {task.savedPath && (
                        <p className="text-[11px] text-emerald-600 dark:text-emerald-400 truncate" title={task.savedPath}>
                          ✓ {t(locale, "tts.saved")}
                        </p>
                      )}
                    </div>
                  );
                })}
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
