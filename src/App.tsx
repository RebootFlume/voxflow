import { useEffect } from "react";
import { Mic, Volume2, Globe, History, Settings, PackageOpen } from "lucide-react";
import { ActivityBar } from "@/components/ActivityBar";
import { useThemeSync } from "@/lib/theme";
import { Sidebar } from "@/components/Sidebar";
import { FloatingBar } from "@/components/FloatingBar";
import { TitleBar } from "@/components/TitleBar";
import { AsrPanel } from "@/modules/asr/AsrPanel";
import { TtsPanel } from "@/modules/tts/TtsPanel";
import { ApiPanel } from "@/modules/api/ApiPanel";
import { HistoryPanel } from "@/modules/history/HistoryPanel";
import { SettingsPanel } from "@/modules/settings/SettingsPanel";
import { ModelsPanel } from "@/modules/models/ModelsPanel";
import { useAppStore } from "@/stores/app";
import { applyModelStatus, resolveModelKind } from "@/lib/modelState";
import { t } from "@/lib/i18n";
import { onSidecarEvent, sendToSidecar } from "@/lib/tauri";
import { listen } from "@tauri-apps/api/event";

const MODULE_ICONS = {
  asr: Mic,
  tts: Volume2,
  api: Globe,
  history: History,
  models: PackageOpen,
  settings: Settings,
} as const;

const HEADING_KEYS: Record<string, string> = {
  asr: "heading.asr",
  tts: "heading.tts",
  api: "heading.api",
  history: "heading.history",
  models: "heading.models",
  settings: "heading.settings",
};

// 模型模块子菜单对应的标题
const MODELS_SUB_HEADING: Record<string, string> = {
  settings: "submenu.settings",
  asr: "submenu.asr",
  tts: "submenu.tts",
};

const ASR_SUB_HEADING: Record<string, string> = {
  hotkey: "submenu.hotkey",
  model: "submenu.model",
  transcribe: "submenu.transcribe",
  status: "submenu.status",
};

const TTS_SUB_HEADING: Record<string, string> = {
  "model-device": "submenu.model-device",
  "voice-settings": "submenu.voice-settings",
  synthesize: "submenu.synthesize",
};

/** 热键变更 → 同步到 Rust */
function useHotkeySync() {
  const hotkey = useAppStore((s) => s.asr.hotkey);
  useEffect(() => {
    if (!hotkey) return;
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke("set_hotkey", { hotkey }).catch(() => {});
    });
  }, [hotkey]);
}

/** 启动兜底：主动查询 GPU 和音频设备信息（不依赖事件推送） */
function useStartupFallback() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const s = useAppStore.getState();
      // GPU：直接调 Rust 同步命令（<100ms，不走 Python）
      if (!s.gpu.name) {
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke<{ available: boolean; gpuName: string; memoryMB: number }>("get_gpu_info").then((info) => {
            useAppStore.getState().setGpu(info.available, info.gpuName, 0);
          }).catch(() => {});
        });
      }
      // 音频设备（Rust 原生）
      if (s.audioDevices.currentName === "…") {
        void import("@/lib/tauri").then(({ rustListAudioDevices }) => {
          rustListAudioDevices().then((result) => {
            const devices = Array.isArray(result.devices) ? result.devices : [];
            useAppStore.getState().setAudioDevices(
              String(result.current ?? "default"),
              typeof result.currentName === "string" ? result.currentName : devices[0]?.name ?? "—",
            );
          }).catch(() => {});
        });
      }
      // 能力检测（FFmpeg）
      if (!s.capabilities.ffmpeg) {
        void sendToSidecar({ action: "check_capabilities" });
      }
      // 导出目录：只在持久化值为空时请求系统默认路径
      if (!s.io.exportDir) {
        void sendToSidecar({ action: "get_default_export_dir" });
      }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, []);
}

/** 模型加载超时兜底：loading 超过 60 秒未变 ready/error → 主动对账，让快照纠偏 */
function useModelLoadTimeout() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.asr.modelStatus === "loading" && prev.asr.modelStatus !== "loading") {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const s = useAppStore.getState();
          if (s.asr.modelStatus === "loading") {
            // 不直接标 error——先问后端真实状态，快照到达后自动纠偏
            s.addLog(t(s.locale, "log.modelLoadTimeout"), "error");
            void sendToSidecar({ action: "get_status" }).catch(() => {});
          }
        }, 120_000);
      } else if (state.asr.modelStatus !== "loading" && prev.asr.modelStatus === "loading") {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);
}

/** 状态对账：启动后 800ms + 窗口聚焦 → 主动查询，消除事件丢失导致的状态不一致 */
function useStatusReconcile() {
  useEffect(() => {
    const reconcile = () => {
      void sendToSidecar({ action: "get_status" }).catch(() => {});
    };
    const t = setTimeout(reconcile, 800);
    window.addEventListener("focus", reconcile);
    return () => {
      clearTimeout(t);
      window.removeEventListener("focus", reconcile);
    };
  }, []);
}

function ModuleIcon() {
  const activeModule = useAppStore((s) => s.activeModule);
  const Icon = MODULE_ICONS[activeModule];
  return <Icon className="mr-1.5 inline h-4 w-4 text-muted-foreground" />;
}

/** 订阅 Sidecar 事件 → 驱动全局状态与运行日志。挂载一次。 */
function useSidecarEvents() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlisten2: (() => void) | undefined;
    let disposed = false;

    void onSidecarEvent((payload) => {
      const store = useAppStore.getState();
      const status = String(payload.status ?? "");
      const model = typeof payload.model === "string" ? payload.model : "";

      // 识别完成后自动回 idle（2 秒后）
      if (status === "recognized") {
        const text = typeof payload.text === "string" ? payload.text : "";
        store.addLog(`${t(store.locale, "log.recognitionResult")}: ${text}`, "success");
        if (text) store.addHistoryRecord(text);
        store.updateAsr({ status: "done" });
        window.setTimeout(() => {
          useAppStore.getState().updateAsr({ status: "idle" });
        }, 2000);
        return;
      }

      // 运行日志：下载进度按 ≥5% 节流，其余全量留痕
      if (status === "model_download_progress") {
        const pct = typeof payload.percent === "number" ? payload.percent : null;
        const last = store.models.items.find((i) => i.name === model)?.percent ?? -100;
        store.applyDownloadProgress(payload);
        if (pct != null && pct - last >= 5) {
          store.addLog(`[download] ${model} ${pct.toFixed(1)}%`, "info");
        }
      } else if (
        status !== "models_state" &&
        status !== "volume" &&
        status !== "tts_preview_ready" &&
        status !== "tts_preview_error" &&
        status !== "accepted" &&
        status !== "status_snapshot" &&
        status !== "model_evicted" &&
        status !== "capabilities" &&
        status !== "transcribe_error" &&
        status !== "transcribe_progress" &&
        status !== "audio_devices" &&
        status !== "tts_done" &&
        status !== "tts_error" &&
        status !== "tts_synthesizing"
      ) {
        const level = status.includes("error")
          ? "error"
          : status === "recognized" || status === "model_ready" || status === "api_started"
            ? "success"
            : "info";
        store.addLog(`[sidecar] ${JSON.stringify(payload)}`, level);
      }

      switch (status) {
        case "models_state":
          store.applyModelsState(payload);
          break;
        case "model_downloaded":
        case "model_download_cancelled":
        case "model_download_error":
          store.applyDownloadDone(status, model);
          void sendToSidecar({ action: "list_models" });
          break;
        case "model_deleted":
        case "model_root_set":
          void sendToSidecar({ action: "list_models" });
          break;
        case "model_ready": {
          const device = typeof payload.device === "string" ? payload.device : null;
          if (device) {
            store.setLoadedModel(model || store.models.loadedModel || "", device);
            const kind = resolveModelKind(model);
            if (kind === "tts") {
              store.setTtsModelStatus("ready");
            } else if (kind === "asr") {
              store.updateAsr({ modelStatus: "ready", device: device as "cpu" | "cuda" });
            }
          }
          break;
        }
        case "model_loading":
          applyModelStatus(resolveModelKind(model), "loading");
          break;
        case "model_not_downloaded":
          applyModelStatus(resolveModelKind(model), "idle");
          break;
        case "model_error":
          applyModelStatus(resolveModelKind(model), "error");
          break;
        // ---- 状态对账：后端真实状态快照，用于纠偏 ----
        case "status_snapshot": {
          const asrSnap = payload.asr as
            | { model?: string; device?: string; loaded?: boolean }
            | undefined;
          if (asrSnap) {
            const loaded = asrSnap.loaded === true;
            const isTts = resolveModelKind(asrSnap.model ?? "") === "tts";
            if (!isTts) {
              if (loaded && asrSnap.device) {
                if (
                  store.asr.modelStatus !== "ready" ||
                  store.asr.device !== asrSnap.device
                ) {
                  store.updateAsr({
                    modelStatus: "ready",
                    device: asrSnap.device as "cpu" | "cuda",
                  });
                }
              } else if (
                !loaded &&
                store.asr.modelStatus === "ready"
              ) {
                store.updateAsr({ modelStatus: "idle" });
              }
            }
          }
          if (
            payload.recording === false &&
            (store.asr.status === "recording" ||
              store.asr.status === "recognizing")
          ) {
            store.updateAsr({ status: "idle" });
          }
          break;
        }
        // ---- 显存不足：被其他模型挤占释放 ----
        case "model_evicted": {
          const evicted = Array.isArray(payload.models) ? payload.models : [];
          const freedFor = typeof payload.freed_for === "string" ? payload.freed_for : "";
          for (const evictedModel of evicted) {
            applyModelStatus(resolveModelKind(String(evictedModel)), "idle");
          }
          if (evicted.length > 0) {
            store.addLog(
              t(store.locale, "log.vramInsufficient", { models: evicted.join(", "), freedFor }),
              "warn",
            );
          }
          break;
        }
        // ---- TTS 合成事件 ----
        case "tts_done": {
          const ttsText = typeof payload.text === "string" ? payload.text : "";
          const savedPath = typeof payload.saved_path === "string" ? payload.saved_path : "";
          const duration = typeof payload.duration === "number" ? payload.duration : undefined;
          const fileSize = typeof payload.size === "string" ? payload.size : undefined;
          const pendingTts = store.ttsTasks.find((t) => t.status === "synthesizing" && t.text === ttsText);
          if (pendingTts) {
            store.updateTtsTask(pendingTts.id, { status: "done", savedPath, duration, fileSize });
          }
          break;
        }
        case "tts_error": {
          const ttsErrMsg = typeof payload.msg === "string" ? payload.msg : t(store.locale, "log.synthesisFailed");
          const synthesizing = store.ttsTasks.find((t) => t.status === "synthesizing");
          if (synthesizing) {
            store.updateTtsTask(synthesizing.id, { status: "error", error: ttsErrMsg });
          }
          break;
        }
        case "recording_started":
          store.updateAsr({ status: "recording", volume: 0 });
          break;
        case "volume":
          // 录音实时音量 → 波形
          if (typeof payload.level === "number") {
            store.updateAsr({ volume: Math.min(1, Math.max(0, payload.level)) });
          }
          break;
        case "recognized":
          break; // 已在 onSidecarEvent 入口处理（含超时回 idle）
        case "api_started":
          store.updateApi({ enabled: true, endpoints: { asr: true, tts: true } });
          break;
        case "api_stopped":
          store.updateApi({ enabled: false, endpoints: { asr: false, tts: false } });
          break;
        case "audio_devices": {
          const devices = Array.isArray(payload.devices) ? payload.devices : [];
          store.setAudioDevices(
            String(payload.current ?? "default"),
            typeof payload.currentName === "string" ? payload.currentName : devices[0]?.name ?? "—",
          );
          break;
        }
        case "gpu_info":
          store.setGpu(
            payload.available === true,
            typeof payload.gpuName === "string" ? payload.gpuName : "",
            typeof payload.deviceCount === "number" ? payload.deviceCount : 0,
          );
          break;
        case "capabilities":
          if (typeof payload.ffmpeg === "boolean") {
            store.setCapabilities({ ffmpeg: payload.ffmpeg });
          }
          break;
        // ---- 转写事件（全局处理，组件卸载不影响） ----
        case "transcribe_progress": {
          const tPath = typeof payload.path === "string" ? payload.path : "";
          const tProgress = typeof payload.progress === "number" ? payload.progress : 0;
          const doneSec = typeof payload.done_sec === "number" ? payload.done_sec : undefined;
          const totalSec = typeof payload.total_sec === "number" ? payload.total_sec : undefined;
          store.updateTranscribeTask(tPath, { status: "transcribing", progress: tProgress, doneSec, totalSec });
          break;
        }
        case "transcribe_done": {
          const dPath = typeof payload.path === "string" ? payload.path : "";
          const dText = typeof payload.text === "string" ? payload.text : "";
          const savedPath = typeof payload.saved_path === "string" ? payload.saved_path : "";
          store.updateTranscribeTask(dPath, { status: "done", progress: 100, result: dText, savedPath });
          break;
        }
        case "transcribe_error": {
          const ePath = typeof payload.path === "string" ? payload.path : "";
          const eMsg = typeof payload.msg === "string" ? payload.msg : t(store.locale, "log.transcriptionFailed");
          store.updateTranscribeTask(ePath, { status: "error", error: eMsg });
          break;
        }
        break;
        default:
          break;
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    // 订阅 Rust 热键状态（CapsLock 按下/松开时立即反映，不等 sidecar 回传）
    void listen<string>("asr://status", (e) => {
      const s = String(e.payload ?? "");
      if (s === "recording" || s === "recognizing") {
        useAppStore.getState().updateAsr({ status: s as "recording" | "recognizing" });
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten2 = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
      unlisten2?.();
    };
  }, []);
}

export default function App() {
  useThemeSync();
  useSidecarEvents();
  useHotkeySync();
  useStartupFallback();
  useModelLoadTimeout();
  useStatusReconcile();
  const activeModule = useAppStore((s) => s.activeModule);
  const activeSubMenu = useAppStore((s) => s.activeSubMenu);
  const locale = useAppStore((s) => s.locale);
  const isRuntimeLogs = activeModule === "history" && activeSubMenu === "runtime";

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      <TitleBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ActivityBar />
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-hidden">
          <div className={isRuntimeLogs ? "flex h-full flex-col p-4" : "mx-auto flex h-full max-w-4xl flex-col gap-4 p-6"}>
            <h2 className="flex shrink-0 items-center text-lg font-semibold tracking-tight">
              <ModuleIcon />
              {activeModule === "models" && MODELS_SUB_HEADING[activeSubMenu]
                ? t(locale, MODELS_SUB_HEADING[activeSubMenu])
                : activeModule === "asr" && ASR_SUB_HEADING[activeSubMenu]
                  ? t(locale, ASR_SUB_HEADING[activeSubMenu])
                  : activeModule === "tts" && TTS_SUB_HEADING[activeSubMenu]
                    ? t(locale, TTS_SUB_HEADING[activeSubMenu])
                    : t(locale, HEADING_KEYS[activeModule])}
            </h2>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
              {activeModule === "asr" && <AsrPanel />}
              {activeModule === "tts" && <TtsPanel />}
              {activeModule === "api" && <ApiPanel />}
              {activeModule === "history" && <HistoryPanel />}
              {activeModule === "models" && <ModelsPanel />}
              {activeModule === "settings" && <SettingsPanel />}
            </div>
          </div>
        </main>
      </div>
      <div className="flex shrink-0 items-center justify-center border-t bg-background/80 py-1.5">
        <FloatingBar />
      </div>
    </div>
  );
}
