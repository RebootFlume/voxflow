import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileAudio, Loader2, Mic, Pencil, Play, Sparkles, Trash2, Volume2, X, type LucideIcon } from "lucide-react";
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
import { t, type Locale } from "@/lib/i18n";
import type { TtsVoiceMode } from "@/stores/slices/ttsSlice";
import {
  openPath,
  rustListTtsSpeakers,
  rustClearTtsCloneVoice,
  rustSetTtsLanguage,
  rustSynthesize,
  rustRecordTtsReference,
  rustTranscribeLlama,
  rustTtsVoicesList,
  rustTtsVoiceAdd,
  rustTtsVoiceUpdate,
  rustTtsVoiceRemove,
  rustTtsVoiceUse,
  type TtsVoiceItem,
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

/** created_ms → 本地化短格式；时间戳无效（0 / 非数 / 越界）时返回空串，不显示噪音 */
function formatCreatedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

// ============================================================
// 音色库：三个同级入口共用的库状态与视图
// ============================================================

/** 顶层模式入口（始终可见，不因模型能力隐藏） */
const VOICE_MODE_TABS: { key: TtsVoiceMode; icon: LucideIcon; labelKey: string }[] = [
  { key: "preset", icon: Volume2, labelKey: "tts.voice.mode.preset" },
  { key: "clone", icon: Mic, labelKey: "tts.voice.mode.clone" },
];

/** 克隆工作区的参考音频来源（不是顶层选项） */
type CloneSource = "record" | "file";

/** 新增音色的命名表单（拿到录音/上传文件后进入；取消即丢弃） */
interface VoiceDraft {
  sourcePath: string;
  name: string;
  note: string;
  referenceText: string;
}

/** 编辑中的条目（originalName 仅用于表单标题） */
interface VoiceEdit {
  id: string;
  originalName: string;
  name: string;
  note: string;
  referenceText: string;
}

interface VoiceLibraryApi {
  voices: TtsVoiceItem[];
  /** 当前生效条目：Rust 的 active_id 与「克隆已下发」两者一致才算（失败不得谎报生效） */
  selectedVoice: TtsVoiceItem | null;
  error: string;
  busyId: string;
  confirmDelId: string;
  setConfirmDelId: (id: string) => void;
  draft: VoiceDraft | null;
  edit: VoiceEdit | null;
  formBusy: boolean;
  formError: string;
  transcribeBusy: boolean;
  transcribeMsg: string;
  startDraft: (sourcePath: string) => void;
  startEdit: (v: TtsVoiceItem) => void;
  patchDraft: (patch: Partial<VoiceDraft>) => void;
  patchEdit: (patch: Partial<VoiceEdit>) => void;
  closeForm: () => void;
  transcribeDraft: () => Promise<void>;
  saveDraft: () => Promise<void>;
  saveEdit: () => Promise<void>;
  applyVoice: (v: TtsVoiceItem) => Promise<void>;
  removeVoice: (v: TtsVoiceItem) => Promise<void>;
}

/** 音色库状态机：清单 / 当前生效 / 命名表单 / 编辑 / 删除（克隆与音频文件两个工作区共用） */
function useVoiceLibrary(): VoiceLibraryApi {
  const locale = useAppStore((s) => s.locale);
  const cloneActive = useAppStore((s) => s.ttsClone.active);
  const updateTtsClone = useAppStore((s) => s.updateTtsClone);
  const [voices, setVoices] = useState<TtsVoiceItem[]>([]);
  const [activeVoiceId, setActiveVoiceId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [confirmDelId, setConfirmDelId] = useState("");
  const [draft, setDraft] = useState<VoiceDraft | null>(null);
  const [edit, setEdit] = useState<VoiceEdit | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [transcribeBusy, setTranscribeBusy] = useState(false);
  const [transcribeMsg, setTranscribeMsg] = useState("");

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

  function closeForm() {
    if (formBusy) return;
    setDraft(null);
    setEdit(null);
    setFormError("");
    setTranscribeMsg("");
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

  /** 自动转写参考文本（复用 llama-server ASR；首次会加载 ASR 模型，较慢） */
  async function transcribeDraft() {
    if (!draft || transcribeBusy) return;
    setTranscribeBusy(true);
    setTranscribeMsg("");
    try {
      const r = await rustTranscribeLlama(draft.sourcePath);
      const text = (r.text ?? "").trim();
      if (text) setDraft((d) => (d ? { ...d, referenceText: text } : d));
      else setTranscribeMsg(t(locale, "tts.voice.add.transcribeEmpty"));
    } catch (e) {
      setTranscribeMsg(t(locale, "tts.voice.add.transcribeFailed", { msg: String(e) }));
    } finally {
      setTranscribeBusy(false);
    }
  }

  /** 保存新音色：入库 → 刷新 → 立即应用（录完即成可选项） */
  async function saveDraft() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setFormError(t(locale, "tts.voice.add.needName"));
      return;
    }
    setFormBusy(true);
    setFormError("");
    try {
      const { id } = await rustTtsVoiceAdd(draft.sourcePath, name, draft.note.trim(), draft.referenceText.trim());
      const list = await refresh();
      setDraft(null);
      setFormBusy(false);
      const created = list?.voices.find((v) => v.id === id);
      if (created) await applyVoice(created);
    } catch (e) {
      setFormBusy(false);
      setFormError(t(locale, "tts.voice.add.saveFailed", { msg: String(e) }));
      useAppStore.getState().addLog(`[tts] 音色入库失败: ${String(e)}`, "error");
    }
  }

  /** 保存编辑：更新条目 → 刷新；改的正是当前生效条目时重新下发（引擎参数跟上） */
  async function saveEdit() {
    if (!edit) return;
    const name = edit.name.trim();
    if (!name) {
      setFormError(t(locale, "tts.voice.add.needName"));
      return;
    }
    setFormBusy(true);
    setFormError("");
    const wasSelected = edit.id === (cloneActive ? activeVoiceId : null);
    try {
      await rustTtsVoiceUpdate(edit.id, name, edit.note.trim(), edit.referenceText.trim());
      const list = await refresh();
      const updated = list?.voices.find((v) => v.id === edit.id);
      setEdit(null);
      setFormBusy(false);
      if (wasSelected && updated) await applyVoice(updated);
    } catch (e) {
      setFormBusy(false);
      setFormError(t(locale, "tts.voice.edit.failed", { msg: String(e) }));
    }
  }

  /** 删除条目（UI 二次确认）；删的是当前生效条目 → 连同引擎参数一起清掉，不留悬空引用 */
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
    if (edit?.id === v.id) {
      setEdit(null);
      setFormError("");
    }
    await refresh();
  }

  return {
    voices,
    selectedVoice: voices.find((v) => v.id === (cloneActive ? activeVoiceId : null)) ?? null,
    error,
    busyId,
    confirmDelId,
    setConfirmDelId,
    draft,
    edit,
    formBusy,
    formError,
    transcribeBusy,
    transcribeMsg,
    startDraft: (sourcePath) => {
      setEdit(null);
      setFormError("");
      setTranscribeMsg("");
      setDraft({ sourcePath, name: "", note: "", referenceText: "" });
    },
    startEdit: (v) => {
      setDraft(null);
      setFormError("");
      setTranscribeMsg("");
      setEdit({ id: v.id, originalName: v.name, name: v.name, note: v.note, referenceText: v.reference_text });
    },
    patchDraft: (patch) => setDraft((d) => (d ? { ...d, ...patch } : d)),
    patchEdit: (patch) => setEdit((e) => (e ? { ...e, ...patch } : e)),
    closeForm,
    transcribeDraft,
    saveDraft,
    saveEdit,
    applyVoice,
    removeVoice,
  };
}

interface VoiceFormProps {
  title: string;
  values: { name: string; note: string; referenceText: string };
  onPatch: (patch: { name?: string; note?: string; referenceText?: string }) => void;
  onSave: () => void;
  onCancel: () => void;
  saveLabel: string;
  busy: boolean;
  error: string;
  requiresText: boolean;
  locale: Locale;
  /** 自动转写（仅新增表单：编辑表单不改音频，不需要重新转写） */
  transcribe?: { busy: boolean; message: string; onRun: () => void };
}

/** 命名表单：名称（必填）+ 说明（可选）+ 参考文本（可自动转写） */
function VoiceForm(props: VoiceFormProps) {
  const { locale, values, onPatch, transcribe } = props;
  return (
    <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
      <span className="block truncate text-xs font-medium" title={props.title}>{props.title}</span>
      <Input
        value={values.name}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onPatch({ name: e.target.value })}
        placeholder={t(locale, "tts.voice.add.namePlaceholder")}
        className="h-8 text-xs"
      />
      <Textarea
        value={values.note}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onPatch({ note: e.target.value })}
        placeholder={t(locale, "tts.voice.add.notePlaceholder")}
        className="min-h-[52px] text-xs"
      />
      <div className="flex items-start gap-2">
        <Textarea
          value={values.referenceText}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onPatch({ referenceText: e.target.value })}
          placeholder={t(locale, "tts.voice.clone.placeholder")}
          className="min-h-[52px] flex-1 text-xs"
        />
        {transcribe && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0"
            disabled={transcribe.busy}
            onClick={transcribe.onRun}
          >
            {transcribe.busy
              ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              : <Sparkles className="mr-1.5 h-3.5 w-3.5" />}
            {t(locale, "tts.voice.add.transcribe")}
          </Button>
        )}
      </div>
      {transcribe && <p className="text-[11px] text-muted-foreground">{t(locale, "tts.voice.add.transcribeHint")}</p>}
      {transcribe?.message && <p className="text-[11px] text-amber-600 dark:text-amber-400">{transcribe.message}</p>}
      {/* requires_text 由模型能力决定：false 时留空即可，true 时必须与音频一致 */}
      <p className="text-[11px] text-muted-foreground">
        {props.requiresText ? t(locale, "tts.voice.clone.textRequired") : t(locale, "tts.voice.clone.textOptional")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-8" disabled={props.busy} onClick={props.onSave}>
          {props.busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {props.saveLabel}
        </Button>
        <Button variant="ghost" size="sm" className="h-8" disabled={props.busy} onClick={props.onCancel}>
          {t(locale, "tts.voice.add.cancel")}
        </Button>
      </div>
      {props.error && <p className="text-xs text-destructive">{props.error}</p>}
    </div>
  );
}

interface VoiceLibraryListProps {
  voices: TtsVoiceItem[];
  selectedId: string | null;
  busyId: string;
  confirmDelId: string;
  onConfirmDelete: (id: string) => void;
  onApply: (v: TtsVoiceItem) => void;
  onPreview: (v: TtsVoiceItem) => void;
  onEdit: (v: TtsVoiceItem) => void;
  onDelete: (v: TtsVoiceItem) => void;
  locale: Locale;
}

/** 音色库列表：名称/说明/创建时间 + 试听 / 应用（或「当前生效」）/ 编辑 / 删除（二次确认） */
function VoiceLibraryList(props: VoiceLibraryListProps) {
  const { locale } = props;
  return (
    <div className="space-y-1.5">
      {props.voices.map((v) => {
        const selected = v.id === props.selectedId;
        const busy = props.busyId === v.id;
        return (
          <div
            key={v.id}
            className={`flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors ${
              selected ? "border-primary bg-primary/10" : "border-border"
            }`}
          >
            <div className="min-w-0 flex-1">
              <span className={`block truncate text-sm font-medium ${selected ? "text-primary" : ""}`}>{v.name}</span>
              {v.note && <span className="block truncate text-xs text-muted-foreground">{v.note}</span>}
              <span className="block text-[10px] text-muted-foreground">{formatCreatedMs(v.created_ms)}</span>
            </div>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : selected ? (
              <Badge variant="outline" className="shrink-0 border-primary/40 px-1.5 py-0 text-[10px] text-primary">
                {t(locale, "tts.voice.lib.selected")}
              </Badge>
            ) : (
              <Button size="sm" className="h-6 shrink-0 px-2 text-[11px]" onClick={() => props.onApply(v)}>
                {t(locale, "tts.voice.lib.apply")}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-[11px]"
              disabled={busy}
              title={t(locale, "tts.voice.lib.preview")}
              onClick={() => props.onPreview(v)}
            >
              <Play className="mr-1 h-3 w-3" />
              {t(locale, "tts.voice.lib.preview")}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              title={t(locale, "tts.voice.lib.edit")}
              onClick={() => props.onEdit(v)}
            >
              <Pencil className="h-3 w-3" />
            </Button>
            {props.confirmDelId === v.id ? (
              <>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-6 shrink-0 px-2 text-[10px]"
                  onClick={() => props.onDelete(v)}
                >
                  {t(locale, "tts.voice.lib.deleteConfirm")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-2 text-[10px]"
                  onClick={() => props.onConfirmDelete("")}
                >
                  {t(locale, "tts.voice.lib.cancel")}
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-destructive"
                title={t(locale, "tts.voice.lib.delete")}
                onClick={() => props.onConfirmDelete(v.id)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
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
  /** 克隆工作区的来源：录音 / 选择音频文件（不是顶层选项） */
  const [cloneSource, setCloneSource] = useState<CloneSource>("record");
  /** 音色库（清单 / 表单 / 应用 / 删除）：克隆工作区使用，状态在 hook 内自持 */
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
      title: t(locale, "tts.voice.add.uploadTitle"),
    });
    if (picked && typeof picked === "string") {
      setRecordSilent(false);
      setRecordError("");
      lib.startDraft(picked);
    }
  }

  /** 录音：录制固定时长，成功后进入命名表单；peak < 0.01 视为没录到声音 */
  async function handleRecord() {
    if (recordLeft > 0) return;
    setRecordError("");
    setRecordSilent(false);
    setRecordLeft(RECORD_SECONDS);
    recordTimer.current = setInterval(() => setRecordLeft((s) => (s <= 1 ? 0 : s - 1)), 1000);
    try {
      const r = await rustRecordTtsReference(RECORD_SECONDS);
      lib.startDraft(r.path);
      setRecordSilent(r.peak < 0.01);
    } catch (e) {
      setRecordError(String(e));
    } finally {
      clearInterval(recordTimer.current ?? 0);
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
          return (
            <button
              key={tab.key}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
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
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {t(locale, "tts.voice.mode.clone")}
              <Badge variant="outline" className="h-4 px-1.5 py-0 text-[10px]">
                {cloneCapable ? t(locale, "tts.voice.clone.supported") : t(locale, "tts.voice.clone.unsupported")}
              </Badge>
            </CardTitle>
            <CardDescription>{t(locale, "tts.voice.cloneDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 space-y-3 overflow-y-auto">
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
                {lib.selectedVoice && (
                  <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                    <Sparkles className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {t(locale, "tts.voice.clone.active", { name: lib.selectedVoice.name })}
                    </span>
                    {/* 取消克隆：清掉引擎里的克隆参数，音色库条目保留 */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 shrink-0 px-2 text-[10px] text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
                      onClick={() => void handleClearClone()}
                    >
                      <X className="mr-1 h-3 w-3" />
                      {t(locale, "tts.voice.clone.cancel")}
                    </Button>
                  </div>
                )}

                {/* 参考音频来源二选一：录音（固定时长，带倒计时/静音提示）或选择音频文件 */}
                <div className="space-y-2 rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-1">
                    <button
                      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
                        cloneSource === "record"
                          ? "bg-primary/10 font-medium text-primary"
                          : "text-muted-foreground hover:bg-muted/50"
                      }`}
                      onClick={() => setCloneSource("record")}
                    >
                      <Mic className="h-3.5 w-3.5" />
                      {t(locale, "tts.voice.source.record")}
                    </button>
                    <button
                      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
                        cloneSource === "file"
                          ? "bg-primary/10 font-medium text-primary"
                          : "text-muted-foreground hover:bg-muted/50"
                      }`}
                      onClick={() => setCloneSource("file")}
                    >
                      <FileAudio className="h-3.5 w-3.5" />
                      {t(locale, "tts.voice.source.file")}
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {cloneSource === "record" ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8"
                          disabled={recordLeft > 0 || lib.formBusy}
                          onClick={() => void handleRecord()}
                        >
                          {recordLeft > 0
                            ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            : <Mic className="mr-1.5 h-3.5 w-3.5" />}
                          {recordLeft > 0
                            ? t(locale, "tts.voice.add.recording", { left: recordLeft })
                            : t(locale, "tts.voice.add.record")}
                        </Button>
                        {recordLeft === 0 && (
                          <span className="text-[11px] text-muted-foreground">
                            {t(locale, "tts.voice.add.hint", { seconds: RECORD_SECONDS })}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8"
                          disabled={lib.formBusy}
                          onClick={() => void handlePickAudio()}
                        >
                          <FileAudio className="mr-1.5 h-3.5 w-3.5" />
                          {t(locale, "tts.voice.add.upload")}
                        </Button>
                        <span className="text-[11px] text-muted-foreground">{t(locale, "tts.voice.add.fileHint")}</span>
                      </>
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
                </div>

              {/* 命名表单：拿到录音/上传文件后出现；取消即丢弃（不入库） */}
              {lib.draft && (
                <VoiceForm
                  locale={locale}
                  title={t(locale, "tts.voice.add.formTitle", {
                    file: lib.draft.sourcePath.split(/[\\/]/).pop() ?? "",
                  })}
                  values={lib.draft}
                  onPatch={lib.patchDraft}
                  onSave={() => void lib.saveDraft()}
                  onCancel={lib.closeForm}
                  saveLabel={t(locale, "tts.voice.add.save")}
                  busy={lib.formBusy}
                  error={lib.formError}
                  requiresText={requiresText}
                  transcribe={{
                    busy: lib.transcribeBusy,
                    message: lib.transcribeMsg,
                    onRun: () => void lib.transcribeDraft(),
                  }}
                />
              )}

              {/* 编辑表单：改名 / 改说明 / 改参考文本（音频不变） */}
              {lib.edit && (
                <VoiceForm
                  locale={locale}
                  title={t(locale, "tts.voice.edit.title", { name: lib.edit.originalName })}
                  values={lib.edit}
                  onPatch={lib.patchEdit}
                  onSave={() => void lib.saveEdit()}
                  onCancel={lib.closeForm}
                  saveLabel={t(locale, "tts.voice.edit.save")}
                  busy={lib.formBusy}
                  error={lib.formError}
                  requiresText={requiresText}
                />
              )}

              {lib.error && <p className="text-xs text-destructive">{lib.error}</p>}
              {ttsClone.status === "error" && ttsClone.error && (
                <p className="text-xs text-destructive">{ttsClone.error}</p>
              )}

              {/* 音色库：条目 = 名称 + 说明 + 试听 / 应用（当前生效高亮）/ 编辑 / 删除 */}
              {lib.voices.length === 0 && !lib.draft && !lib.edit ? (
                <p className="text-xs text-muted-foreground">{t(locale, "tts.voice.lib.empty")}</p>
              ) : (
                <VoiceLibraryList
                  locale={locale}
                  voices={lib.voices}
                  selectedId={lib.selectedVoice?.id ?? null}
                  busyId={lib.busyId}
                  confirmDelId={lib.confirmDelId}
                  onConfirmDelete={lib.setConfirmDelId}
                  onApply={(v) => void lib.applyVoice(v)}
                  onPreview={(v) => void openPath(v.audio_path)}
                  onEdit={lib.startEdit}
                  onDelete={(v) => void lib.removeVoice(v)}
                />
              )}
              <p className="text-[11px] text-muted-foreground">{t(locale, "tts.voice.clone.hint")}</p>
            </>
          )}
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
