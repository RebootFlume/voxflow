import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileAudio, FileText, Info, Loader2, Mic, Pencil, Play, RotateCw, Sparkles, Trash2, Volume2, X, type LucideIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
  rustSetTtsInstruct,
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
  rustReadTextFile,
  type TtsVoiceItem,
} from "@/lib/ipc";
import { MAX_CHARS_PER_CHUNK, splitText } from "@shared/tts-chunk";
import { belongsToFramework, findModelItem, frameworkKeyLabel, frameworkOptionsOf, loadedFrameworkLabel, modelDisplayName, selectLoadingKind, supportsClone, ttsModelInfoOf } from "@/lib/modelState";
import { ttsParamControls, type TtsParamControl } from "@/lib/ttsCapabilities";
import { useAudioPreview } from "@/lib/useAudioPreview";
import { loadTtsModel, selectTtsFramework } from "@/lib/modelLoader";
import { useExportDir } from "@/lib/useExportDir";

/**
 * IPC 抛出的错误带一层 Electron 前缀，直接显示给用户是一句废话：
 *   "Error invoking remote method 'voxflow:invoke': Error: 文件过大（3.0MB，上限 2MB）"
 * 主进程抛的才是真正的原因，剥掉壳再展示。
 */
function describeIpcError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "");
}

/**
 * WAV 可容纳的最长音频（分钟）。
 *
 * RIFF 的 data 段是 32 位字节数，上限 4GB。24kHz / 16bit / 单声道 = 48KB/s，
 * 4GB ≈ 24.9 小时。留一点余量按 24 小时算；按 5 字/秒 ≈ 43 万字。
 * 主进程（wav-writer 的 MAX_WAV_DATA_BYTES）也会拦，这里是提前提示。
 */
const WAV_MAX_MINUTES = 24 * 60;

// ============================================================
// 模型与设备子页面
// ============================================================

function ModelDevicePage() {
  const tts = useAppStore((s) => s.tts);
  const gpu = useAppStore((s) => s.gpu);
  const locale = useAppStore((s) => s.locale);
  const updateTts = useAppStore((s) => s.updateTts);
  const modelItems = useAppStore((s) => s.models.items);
  const runtimePackages = useAppStore((s) => s.runtime.packages);
  // 引擎实际状态（含实际生效的设备）：判断"已加载的模型是否属于当前框架""设备是否待应用"
  const engine = useAppStore((s) => s.engines.tts);
  // 加载中禁用"会发起加载"的入口：门禁会拦下请求，但那是点完之后的事
  const loading = useAppStore(selectLoadingKind) !== null;

  // 框架下拉项：TTS 模型清单里的运行时包 key（去重，onnx 垫底）—— 共用 frameworkOptionsOf，
  // 与 ASR 面板同一处实现，顺序规则不会两边漂移
  const frameworkOptions = frameworkOptionsOf(modelItems, "tts", runtimePackages, tts.framework);

  // 已加载的模型不属于当前框架 → 说明"现在跑的是别的框架的模型"（切框架不会替你卸载）
  const loadedItem = findModelItem(modelItems, engine.model ?? "");
  const loadedOtherFramework =
    engine.status === "ready" && !!engine.model && !belongsToFramework(loadedItem, tts.framework);
  // 设备待应用：引擎已就绪，且当前设备偏好 ≠ 引擎实际生效的设备
  const devicePending = engine.status === "ready" && !!engine.device && tts.device !== engine.device;
  // 「当前」行的框架展示名（引擎里那个模型属于哪个运行时包）
  const loadedFw = loadedFrameworkLabel("tts");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t(locale, "tts.device")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 切设备只存偏好：真正重载由「应用并重载」触发（与 ASR 面板同一套约定） */}
          <Select value={tts.device} disabled={loading} onValueChange={(device) => updateTts({ device })}>
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
          {devicePending && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {t(locale, "tts.device.pending", { device: tts.device.toUpperCase() })}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t(locale, "tts.device.pendingHint")}
                </p>
              </div>
              <Button
                size="sm"
                disabled={loading || !tts.model}
                onClick={() => void loadTtsModel(tts.model, tts.device)}
              >
                <RotateCw className="mr-1.5 h-3.5 w-3.5" />
                {t(locale, "tts.device.apply")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t(locale, "tts.model")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 推理框架：**只改选中，不加载也不卸载** —— 加载只发生在点模型卡片的时候 */}
          <div className="flex items-center gap-3">
            <label className="shrink-0 text-sm font-medium">{t(locale, "tts.framework.label")}</label>
            <Select
              value={tts.framework}
              disabled={loading}
              onValueChange={(framework) => selectTtsFramework(framework)}
            >
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
            {t(locale, "tts.framework.hint", {
              framework: frameworkKeyLabel(tts.framework, runtimePackages),
            })}
          </p>

          {/* 已加载的模型属于别的框架：切框架不会替你卸载，这里如实说明 */}
          {loadedOtherFramework && (
            <div className="rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-sky-700 dark:text-sky-400">
              {t(locale, "tts.framework.loaded", {
                model: modelDisplayName(modelItems, engine.model ?? ""),
                framework: loadedFw || engine.framework || "",
              })}
              <span className="ml-2 text-muted-foreground">{t(locale, "tts.framework.loadedHint")}</span>
            </div>
          )}

          {/* 模型选择器：只展示已下载 + 属于当前框架的模型；点卡片 = 加载它（唯一的加载入口） */}
          <ModelSelector
            kind="tts"
            selected={tts.model}
            formatFilter={tts.framework}
            onSelect={(name) => {
              void loadTtsModel(name, tts.device);
            }}
          />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t(locale, "tts.current")}: </span>
            {/* 读引擎状态而不是选中项：切框架/换选中都不该让这行"忘记"正在起作用的模型。
                带框架名是因为模型名不保证跨框架唯一（llama / sherpa 可能重名）。 */}
            <ModelStatusBadge status={engine.status} modelName={engine.model ?? ""} />
            {engine.status === "ready" && loadedFw && (
              <span className="text-muted-foreground">({loadedFw})</span>
            )}
          </div>

          {/* 启动时是否自动加载上次的模型（默认关：TTS 是按需服务） */}
          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t(locale, "models.autoLoad")}</div>
              <div className="text-xs text-muted-foreground">{t(locale, "models.autoLoad.ttsDesc")}</div>
            </div>
            <Switch checked={tts.autoLoad} onCheckedChange={(autoLoad) => updateTts({ autoLoad })} />
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
  const resetTtsClone = useAppStore((s) => s.resetTtsClone);
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
        id: v.id,
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
    const picked = await window.voxflow.openDialog({
      kind: "file",
      multiple: false,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "ogg", "m4a"] }],
      title: t(locale, "tts.voice.add.uploadTitle"),
    });
    if (picked.canceled || !picked.paths[0]) return;
    resetModal();
    setModal({ kind: "add", source: "file", sourcePath: picked.paths[0], name: "", note: "", referenceText: "" });
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

  /** 自动转写参考文本（复用 ASR 引擎；首次会加载 ASR 模型，较慢；失败不阻断保存） */
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
      // 改的是生效条目 ⇒ 参考音频/参考文本变了，引擎里的必须跟着换
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
      resetTtsClone();
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
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              {/* 不提供「使用」：选中哪条克隆音色统一在合成页的音色下拉里做，
                  否则同一份 ttsClone 有两个写入点（谁后点谁生效）。 */}
              {selected && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => useAppStore.getState().setActiveSubMenu("synthesize")}
                >
                  {t(locale, "tts.gotoSynthesize")}
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
  const resetTtsClone = useAppStore((s) => s.resetTtsClone);
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
  /** 音色描述（instruct）能力：由描述符下发，缺省视为不支持 */
  const instructCapable = info?.supports_instruct === true;
  /** 克隆能力：与「模型就绪恢复」同源（modelState.supportsClone） */
  const cloneCapable = supportsClone(info);
  /** 克隆入口门控：只有"能力明确为否"才拦截；能力**未知**（旧 payload 未声明能力）保持既有行为，
   *  不把"不知道"当成"不支持"（`vm === undefined && supports_clone === undefined` = 未知）。
   *  引擎侧 set_clone_voice 仍是最终兜底：门控只是不让人白做录音/命名。 */
  const cloneDeclared = vm !== undefined || info?.supports_clone !== undefined;
  const cloneBlocked = Boolean(info) && cloneDeclared && cloneCapable === false;
  /** 预设音色不可用：模型明确「仅克隆」（voice_mode.type === 'clone'）⇒ 预设页禁用，
   *  与 cloneBlocked 互为镜像（两个页永远不会同时禁用：fixed 模型用预设页显示固定音色）。 */
  const presetBlocked = Boolean(info) && mode === "clone";
  // 模型换成不支持克隆的 ⇒ 自动退出克隆工作区（否则录音+命名做完，点「使用」才被引擎拒绝）
  useEffect(() => {
    if (cloneBlocked && tts.voiceMode === "clone") updateTts({ voiceMode: "preset" });
  }, [cloneBlocked, tts.voiceMode, updateTts]);
  // 模型只支持克隆 ⇒ 自动切到克隆工作区（否则停在禁用的预设页，界面看着像坏了）
  useEffect(() => {
    if (presetBlocked && tts.voiceMode === "preset") updateTts({ voiceMode: "clone" });
  }, [presetBlocked, tts.voiceMode, updateTts]);
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
      // 描述可能还在防抖窗口里：试听必须先让它落到引擎，否则听到的是旧音色
      if (instructCapable) await flushInstruct();
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

  /**
   * 把音色描述下发给引擎；失败只记日志，不打断用户输入。
   *
   * 返回 promise 供调用方 await（试听 / 清空要先确保引擎拿到最新描述）。
   */
  async function syncInstruct(text: string) {
    try {
      await rustSetTtsInstruct(text);
    } catch (e) {
      useAppStore.getState().addLog(`[tts] 音色描述下发失败: ${String(e)}`, "error");
    }
  }

  /**
   * 试听前把描述同步给引擎。
   *
   * 描述输入框已经搬到「文字转语音」页（见 ttsCapabilities.ts 的单一设置点约定），
   * 这里不再持有防抖计时器：只要保证引擎拿到的和 store 里的一致即可，重复下发是幂等的。
   */
  async function flushInstruct() {
    await syncInstruct(useAppStore.getState().tts.instruct);
  }

  async function handleClearClone() {
    try {
      await rustClearTtsCloneVoice();
    } catch { /* ignore */ }
    resetTtsClone();
  }

  return (
    <div className="flex min-h-full flex-col gap-3">
      {/* 顶层两个同级入口：内置预设音色 / 克隆音色（始终可见，选中后整页 = 该工作区） */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 self-start rounded-lg border bg-card p-1">
        {VOICE_MODE_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = tts.voiceMode === tab.key;
          const blocked = tab.key === "clone" ? cloneBlocked : presetBlocked;
          const blockedText =
            tab.key === "clone" ? "tts.voice.cloneUnsupported" : "tts.voice.presetUnsupported";
          return (
            <button
              key={tab.key}
              disabled={blocked}
              title={blocked ? t(locale, blockedText) : undefined}
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
        {presetBlocked && (
          <span className="px-2 text-xs text-muted-foreground">
            {t(locale, "tts.voice.presetUnsupported")}
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
            {/* 职责分离：本页只「听」，参数统一在「文字转语音」页设置 */}
            <p className="text-[11px] text-muted-foreground">
              {t(locale, "tts.voice.previewOnlyHint")}
              <button
                className="ml-1 text-primary underline-offset-2 hover:underline"
                onClick={() => useAppStore.getState().setActiveSubMenu("synthesize")}
              >
                {t(locale, "tts.gotoSynthesize")}
              </button>
            </p>
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
                {/* 音色描述不在这里：参数只在「文字转语音」页设置（本页只负责听） */}
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
                {/* sid 越界不再给「改为第一个音色」按钮：voice 的唯一写入点在合成页，
                    模型就绪时 useSidecarEvents 已自动对齐，这里只做说明性提示。 */}
                {voiceOutOfRange && (
                  <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                    {t(locale, "tts.voice.outOfRange", { min: sidMin, max: sidMax })}
                  </p>
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
                          {/* 本页只负责「听」：音色参数统一在「文字转语音」页设置，
                              避免同一份 tts.voice 有两个写入点（谁覆盖谁全看用户操作顺序）。 */}
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
                          {selected && (
                            <Badge variant="outline" className="shrink-0 border-primary/40 px-1.5 py-0 text-[10px] text-primary">
                              {t(locale, "tts.voice.lib.selected")}
                            </Badge>
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
                不列"可切到哪些克隆模型"：用哪个模型由用户自己决定（后续接入更多引擎后
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
  /** 引擎就绪状态也作为依赖：音色列表来自**引擎**，不是清单。
   *  只依赖 tts.model 会漏掉「加载同一个模型」的场景（点了卡片但选中值没变）
   *  —— 那时引擎起来了，列表却还是上一次加载前的空数组。 */
  const engineReady = useAppStore((s) => s.engines.tts.status);
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
  }, [model, langDep, engineReady]);

  return { speakers, numSpeakers };
}

/**
 * 合成语言控件。形态完全由能力表决定（见 ttsCapabilities.ts）：
 * `edit` 只是 select 一种，其余是「为什么不能选」的徽标。
 */
function LanguageSelector({ control }: { control: TtsParamControl }) {
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

  if (control.kind === "hidden") return null;

  // 只读徽标：模型没有语言自由度，但「为什么没有」有信息量 ⇒ 灰底文字，不留白
  if (control.kind === "badge") {
    // 自动识别用绿色（这是能力，不是限制）；其余用中性灰
    const isAuto = control.badgeKey === "tts.languageAuto";
    if (!info) {
      return <span className="text-xs text-muted-foreground">{t(locale, control.badgeKey!)}</span>;
    }
    return (
      <span
        className={
          isAuto
            ? "inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1 text-xs text-emerald-600 dark:text-emerald-400"
            : "inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground"
        }
      >
        {isAuto && <Sparkles className="h-3.5 w-3.5" />}
        {control.badgeVars?.lang
          ? t(locale, control.badgeKey!, { lang: langLabel(control.badgeVars.lang) })
          : t(locale, control.badgeKey!)}
      </span>
    );
  }

  // select 模式（Supertonic 31 语言 / Qwen3-TTS 10 语言）→ 下拉（选项来自描述符）
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
  const updateTts = useAppStore((s) => s.updateTts);
  const ttsClone = useAppStore((s) => s.ttsClone);
  const ttsModelStatus = useAppStore((s) => s.ttsModelStatus);
  const tasks = useAppStore((s) => s.ttsTasks);
  /**
   * 合成输入放在 store（不是 useState）：TtsPanel 按子页面条件渲染，
   * 切到「模型与设备」加载模型再回来，组件会卸载 —— 本地 state 里刚导入的文件、
   * 刚打的草稿全没了。而"先导入、再去加载模型、回来合成"正是主流动线。
   */
  const ttsInput = useAppStore((s) => s.ttsInput);
  const updateTtsInput = useAppStore((s) => s.updateTtsInput);
  const { source, text, file: textFile } = ttsInput;
  /** 读取中 / 读取失败原因（纯瞬态，切页丢掉无妨） */
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState("");
  /** 正在等 `rust_synthesize` 返回的任务 id：派发 effect 的去重锁（串行队列下最多一个在飞） */
  const inFlightRef = useRef<number | null>(null);
  /** 队列里还有未跑完的任务（只驱动按钮 spinner，不参与 disabled —— 合成中仍可继续排队） */
  const queued = tasks.some((t) => t.status === "pending" || t.status === "synthesizing");
  const audio = useAudioPreview();
  const { speakers } = useTtsSpeakers();
  /** 克隆音色库：合成页的音色下拉要能选到它们（来源与预设不同，合并成一份列表） */
  const [cloneVoices, setCloneVoices] = useState<TtsVoiceItem[]>([]);
  useEffect(() => {
    let alive = true;
    void rustTtsVoicesList()
      .then((r) => {
        if (alive) setCloneVoices(r.voices ?? []);
      })
      .catch(() => {
        /* 库不可读：下拉退化为只有预设音色，不阻断合成 */
      });
    return () => {
      alive = false;
    };
  }, [ttsClone.id, ttsClone.active]);
  /** 下拉值域：`preset:<sid>` / `clone:<voiceId>`。两种来源语义不同，用前缀区分。
   *  空 voice = 用列表第一个（引擎的实际行为）⇒ 下拉要显示成那个，否则 Radix 找不到匹配项会渲染空白。 */
  const voiceSelectValue =
    ttsClone.active && ttsClone.id
      ? `clone:${ttsClone.id}`
      : speakers.length > 0
        ? `preset:${tts.voice || String(speakers[0].sid)}`
        : undefined;
  /** 切换音色：选预设自动退出克隆（两者互斥），选克隆立刻下发参考音频 */
  const changeVoice = useCallback(
    async (value: string) => {
      const st = useAppStore.getState();
      if (value.startsWith("preset:")) {
        st.updateTts({ voice: value.slice(7) });
        if (st.ttsClone.active) {
          try {
            await rustClearTtsCloneVoice();
          } catch {
            /* 引擎未加载时清理失败无妨，resetTtsClone 之后不会再显示"克隆生效" */
          }
          st.resetTtsClone();
        }
        return;
      }
      const id = value.slice(6);
      try {
        await rustTtsVoiceUse(id);
        const v = cloneVoices.find((x) => x.id === id);
        st.updateTtsClone({
          active: true,
          id,
          name: v?.name ?? "",
          audioPath: v?.audio_path ?? "",
          referenceText: v?.reference_text ?? "",
          status: "ok",
          error: "",
        });
      } catch (e) {
        const msg = String(e);
        st.addLog(`[tts] 选择克隆音色失败: ${msg}`, "error");
        st.updateTtsClone({ status: "error", error: msg });
      }
    },
    [cloneVoices],
  );
  const modelInfo = useTtsModelInfo(tts.model);
  /** 克隆音色只在支持克隆的模型上列出：不支持时选它是**必然失败**的操作，
   *  摆在选项里等于给人挖坑（这类模型的预设音色够用，不给就没有歧义）。 */
  const cloneSelectable = supportsClone(modelInfo) ? cloneVoices : [];
  /** 是否给出音色下拉：有预设音色或可用的克隆条目即可；单音色模型两者都空 ⇒ 只读 */
  const voiceSelectable = speakers.length > 0 || cloneSelectable.length > 0;
  /** 引擎是否就绪：两个信号取"或"——`engines.tts`（modelState 约定的权威字段）与旧徽章
   *  `ttsModelStatus`。二者都出自 sidecar 事件，而启动快照（status_snapshot）只同步 ASR，
   *  单看一个信号可能在"引擎已就绪但事件漏收"时把按钮永久禁掉 ⇒ 任一为就绪即允许。 */
  const ttsEngineReady = useAppStore((s) => s.engines.tts.status === "ready");
  const canSynth = ttsEngineReady || ttsModelStatus === "ready";

  /**
   * 当前要合成的文本 —— 唯一的判定点。
   * 两个来源互斥，所以这里是 if/else 而不是拼接。
   */
  const synthText = source === "file" ? (textFile?.body ?? "") : text;

  /** 分段与时长预估：与主进程共用 `splitText`，段数不会与后端漂移 */
  const synthStats = useMemo(() => {
    const trimmed = synthText.trim();
    if (!trimmed) return null;
    const chunks = splitText(trimmed, MAX_CHARS_PER_CHUNK).length;
    const chars = [...trimmed].length;
    // 中文朗读约 5 字/秒；只用于"要等多久"的量级提示，界面明确写「约」
    const minutes = Math.max(1, Math.round(chars / 5 / 60));
    /**
     * 超过这行长度的文本不必再往后端送 —— WAV 的 data 段是 32 位字节数，
     * 封顶 4GB（24kHz/16bit/mono ≈ 24.9 小时 ≈ 45 万字）。
     * 提前拦下比让用户等几小时后拿到一个播放器打不开的文件强。
     */
    const tooLong = minutes > WAV_MAX_MINUTES;
    return { chars, chunks, minutes, tooLong };
  }, [synthText]);
  /** 参数控件表：哪个字段可编辑 / 只能只读展示 / 根本不出现，由模型能力决定 */
  const controls = useMemo(() => ttsParamControls(modelInfo), [modelInfo]);
  /** 音色描述：**唯一的设置点在这一页**（音色设置页只负责试听） */
  const instructTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncInstruct = useCallback(async (value: string) => {
    try {
      await rustSetTtsInstruct(value);
    } catch (e) {
      useAppStore.getState().addLog(`[tts] 音色描述下发失败: ${String(e)}`, "error");
    }
  }, []);
  /** 输入即下发（300ms 防抖）：合成可能紧跟输入发生，不能等到失焦才生效 */
  function queueInstruct(value: string) {
    if (instructTimer.current) clearTimeout(instructTimer.current);
    instructTimer.current = setTimeout(() => {
      instructTimer.current = null;
      void syncInstruct(value);
    }, 300);
  }
  /** 立即下发待处理的描述（合成前调用，保证任务用的是最新描述） */
  async function flushInstruct() {
    if (instructTimer.current) {
      clearTimeout(instructTimer.current);
      instructTimer.current = null;
    }
    await syncInstruct(useAppStore.getState().tts.instruct);
  }
  /** 音色展示：**克隆生效时显示克隆音色名**（此时引擎用的是参考音频，sid 无关）；
   *  否则按 sid 去 `speakers.json` 查名字；两者都拿不到（未加载模型 / sid 不在当前列表）
   *  ⇒ 「默认音色」——不能把裸 sid 当成"当前音色"展示。 */
  const voiceText = (() => {
    if (ttsClone.active) return ttsClone.name || t(locale, "tts.voice.mode.clone");
    const name = speakers.find((s) => String(s.sid) === tts.voice)?.name;
    if (name) return name;
    if (speakers.length > 0) return speakers[0].name;
    // 既没有预设音色也没激活克隆（ZipVoice / Qwen3 Base 这类仅克隆模型）：
    // 说「默认音色」是错的 —— 它们没有默认音色，不给参考音频根本合不出人声
    return t(locale, "tts.voice.cloneNeeded");
  })();

  // 共享导出目录（与 ASR 转写共用一份）
  const { exportDir, setExportDir } = useExportDir();

  const browseDir = useCallback(async () => {
    const picked = await window.voxflow.openDialog({
      kind: "directory",
      multiple: false,
      title: t(locale, "common.selectDir"),
      defaultPath: exportDir || undefined,
    });
    if (!picked.canceled && picked.paths[0]) setExportDir(picked.paths[0]);
  }, [exportDir, setExportDir]);

  /** 选一个 .txt/.md 并读入（编码识别在主进程做） */
  async function pickTextFile() {
    const picked = await window.voxflow.openDialog({
      kind: "file",
      multiple: false,
      filters: [
        { name: t(locale, "tts.source.file"), extensions: ["txt", "md"] },
        { name: "All", extensions: ["*"] },
      ],
      title: t(locale, "tts.source.pick"),
    });
    if (picked.canceled || !picked.paths[0]) return;
    const path = picked.paths[0];
    setFileBusy(true);
    setFileError("");
    try {
      const r = await rustReadTextFile(path);
      if (!r.text.trim()) {
        setFileError(t(locale, "tts.source.readFailed", { msg: "文件没有内容" }));
        return;
      }
      const name = path.split(/[/\\]/).pop() ?? path;
      updateTtsInput({
        file: { path, name, chars: r.chars, encoding: r.encoding, body: r.text },
        source: "file",
      });
      useAppStore
        .getState()
        .addLog(`[synthesize] 已导入 ${name}（${r.chars} 字，${r.encoding}）`, "info");
    } catch (e) {
      setFileError(t(locale, "tts.source.readFailed", { msg: describeIpcError(e) }));
    } finally {
      setFileBusy(false);
    }
  }

  /** 清掉已导入的文件，退回「直接输入」 */
  function clearTextFile() {
    updateTtsInput({ file: null, source: "text" });
    setFileError("");
  }

  // 入队：只登记 pending 任务并清空输入（不 await），真正派发交给下面的串行派发 effect
  function enqueueSynthesize() {
    const trimmed = synthText.trim();
    if (!trimmed) return;
    const st = useAppStore.getState();
    st.addLog(`[synthesize] queued: "${trimmed.slice(0, 40)}" voice=${tts.voice} dir=${st.io.exportDir || "-"}`, "info");
    st.addTtsTask({ text: trimmed, voice: tts.voice, voiceLabel: voiceText, status: "pending" });
    // 清空"刚提交的那个来源"：文件源提交后保留文件（用户可能想换音色再合成一次），
    // 只清输入框 —— 否则 60 万字的文件被清掉，重选一次要等好几秒。
    if (source === "text") updateTtsInput({ text: "" });
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
      // 描述可能还在防抖窗口里：先落地，避免"改了描述但这次合成没用上"
      if (controls.instruct.kind === "edit") await flushInstruct();
      const res = (await rustSynthesize(task.text, task.voice, dir)) as {
        saved_path?: string;
        size?: string;
        cancelled?: boolean;
      };
      const cur = useAppStore.getState();
      if (res.cancelled === true) {
        // 段边界取消。流式写盘后**可能已经有产物**：跑到一半取消，
        // 前半段音频还在盘上且可播放 —— 有就保留，别让用户白等。
        const partial = String(res.saved_path || "");
        cur.addLog(
          `[synthesize] cancelled${partial ? `（已保留部分产物 ${res.size || ""}）` : ""}: "${task.text.slice(0, 40)}"`,
          "warn",
        );
        cur.updateTtsTask(task.id, {
          status: "cancelled",
          cancelling: false,
          progress: undefined,
          savedPath: partial || undefined,
          fileSize: partial ? String(res.size || "") : undefined,
        });
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
          {controls.language.kind !== "hidden" && (
            <div className="flex h-10 items-center gap-4">
              <span className="w-20 shrink-0 text-sm font-medium">{t(locale, "tts.language")}</span>
              <div className="flex flex-1 items-center">
                <LanguageSelector control={controls.language} />
              </div>
            </div>
          )}
          {controls.voice.kind !== "hidden" && (
          <div className="flex min-h-10 items-center gap-4">
            <span className="w-20 shrink-0 text-sm font-medium">{t(locale, "tts.voice.label")}</span>
            <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
              {voiceSelectable ? (
                /* 唯一设置点：预设与克隆合并在一个下拉里，用前缀区分值域。
                   选预设会自动退出克隆，选克隆会立刻把参考音频下发给引擎。 */
                <Select value={voiceSelectValue} onValueChange={(v) => void changeVoice(v)}>
                  <SelectTrigger className="h-8 w-56">
                    <SelectValue placeholder={t(locale, "tts.voice.selectPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {speakers.length > 0 && (
                      <SelectGroup>
                        <SelectLabel className="text-[11px] text-muted-foreground">
                          {t(locale, "tts.voice.group.preset")}
                        </SelectLabel>
                        {speakers.map((sp) => (
                          <SelectItem key={`p${sp.sid}`} value={`preset:${sp.sid}`}>
                            {sp.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {cloneSelectable.length > 0 && (
                      <SelectGroup>
                        <SelectLabel className="text-[11px] text-muted-foreground">
                          {t(locale, "tts.voice.group.clone")}
                        </SelectLabel>
                        {cloneSelectable.map((v) => (
                          <SelectItem key={`c${v.id}`} value={`clone:${v.id}`}>
                            {v.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
              ) : (
                /* 单音色模型 / 没有可选来源：只读展示实际音色 */
                <span>{voiceText}</span>
              )}
              {ttsClone.active && (
                <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                  {t(locale, "tts.voice.mode.clone")}
                </Badge>
              )}
            </div>
          </div>
          )}
          {controls.instruct.kind === "edit" && (
            /* 音色描述：与音色选择正交（用哪个音色 vs 音色听起来怎样） */
            <div className="flex items-start gap-4 pt-1">
              <span className="h-8 w-20 shrink-0 pt-1.5 text-sm font-medium">{t(locale, "tts.voice.instruct")}</span>
              <div className="flex min-w-0 flex-1 items-start gap-2">
                <Textarea
                  id="tts-instruct"
                  value={tts.instruct}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                    updateTts({ instruct: e.target.value });
                    queueInstruct(e.target.value);
                  }}
                  onBlur={() => void flushInstruct()}
                  placeholder={t(locale, "tts.voice.instructPlaceholder")}
                  className="min-h-[56px] resize-y text-xs"
                  rows={2}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0"
                  disabled={!tts.instruct.trim()}
                  onClick={() => {
                    updateTts({ instruct: "" });
                    if (instructTimer.current) {
                      clearTimeout(instructTimer.current);
                      instructTimer.current = null;
                    }
                    void syncInstruct("");
                  }}
                >
                  {t(locale, "tts.voice.instructClear")}
                </Button>
              </div>
            </div>
          )}
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
          {/* 输入源切换：直接输入 vs 导入 TXT（互斥）。
              用按钮组而不是 Tabs 组件：这里没有"面板"语义，切换只改变下方一个控件。 */}
          <div className="flex items-center gap-2" role="radiogroup" aria-label={t(locale, "tts.source.type")}>
            {(["text", "file"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={source === k}
                onClick={() => {
                  if (source === k) return;
                  // 只切换来源，**不销毁**另一侧的内容。
                  // 互斥由 `source` 保证（合成时只取其一），不需要靠清空来"证明"——
                  // 用户临时改几个字再切回来，不该白白丢掉刚读进来的几十万字文件。
                  // 真正的清空入口是下面的「清除」按钮（显式、可预期）。
                  setFileError("");
                  updateTtsInput({ source: k });
                }}
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  source === k
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/40"
                }`}
              >
                {k === "text" ? <Pencil className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
                {t(locale, k === "text" ? "tts.source.text" : "tts.source.file")}
              </button>
            ))}
          </div>

          {source === "text" ? (
            <Textarea
              value={text}
              onChange={(e) => updateTtsInput({ text: e.target.value })}
              placeholder={t(locale, "tts.inputPlaceholder")}
              className="min-h-[100px]"
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) enqueueSynthesize(); }}
            />
          ) : textFile ? (
            /* 已导入：只显示摘要，不把全文倒进输入框（几十万字会让受控组件卡死） */
            <div className="rounded-lg border bg-muted/30 px-3 py-2.5 space-y-1">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={textFile.path}>
                  {textFile.name}
                </span>
                <Button size="sm" variant="ghost" className="h-7 shrink-0" onClick={() => void pickTextFile()}>
                  {t(locale, "tts.source.change")}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 shrink-0" onClick={clearTextFile}>
                  {t(locale, "tts.source.clear")}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {synthStats
                  ? t(locale, "tts.source.stats", {
                      chars: synthStats.chars.toLocaleString(),
                      chunks: synthStats.chunks,
                      minutes: synthStats.minutes,
                    })
                  : ""}
                {" · "}
                {t(locale, "tts.source.encoding", { enc: textFile.encoding })}
              </p>
              {synthStats?.tooLong && (
                <p className="text-[11px] text-destructive">{t(locale, "tts.source.tooLong")}</p>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed px-3 py-6 text-center space-y-2">
              <FileText className="mx-auto h-6 w-6 text-muted-foreground/60" />
              <p className="text-[11px] text-muted-foreground">{t(locale, "tts.source.emptyHint")}</p>
              <Button size="sm" variant="outline" disabled={fileBusy} onClick={() => void pickTextFile()}>
                {fileBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <FileText className="mr-1.5 h-3.5 w-3.5" />}
                {fileBusy ? t(locale, "tts.source.reading") : t(locale, "tts.source.pick")}
              </Button>
            </div>
          )}

          {fileError && <p className="text-[11px] text-destructive">{fileError}</p>}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {/* 空值 / 名字查不到 ⇒ 显示「默认音色」，不渲染成 "sid " */}
              <span>
                {t(locale, "tts.voiceLabel")}: {voiceText}
              </span>
            </div>
            {!canSynth && (
              // 未加载时不只是灰掉按钮：给出口（去模型与设备页）—— 空跑一次只会拿到
              // 后端那句"TTS 模型未加载"，用户还得自己找在哪加载
              <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                {t(locale, "tts.voice.needModel")}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={() => useAppStore.getState().setActiveSubMenu("model-device")}
                >
                  {t(locale, "tts.gotoModelDevice")}
                </Button>
              </span>
            )}
            <Button
              size="sm"
              onClick={enqueueSynthesize}
              disabled={synthText.trim() === "" || !canSynth || synthStats?.tooLong === true}
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
                        {/* 只渲染前 200 字：导入 TXT 后 task.text 可能是几十万字，
                            line-clamp-2 只是视觉裁切，DOM 里依然是全文 —— 任务列表多几条就卡 */}
                        <p className="text-sm flex-1 line-clamp-2">{task.text.slice(0, 200)}</p>
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
                        {/* 取消也可能留下部分产物（流式写盘边合成边落盘），有路径就能听 */}
                        {task.savedPath && (task.status === "done" || task.status === "cancelled") && (
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
                          {task.status === "cancelled" ? "·" : "✓"}{" "}
                          {task.status === "cancelled"
                            ? t(locale, "tts.savedPartial")
                            : t(locale, "tts.saved")}
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
