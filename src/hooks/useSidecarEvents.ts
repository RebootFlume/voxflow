import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { onSidecarEvent, sendToSidecar } from "@/lib/tauri";
import { applyEngineStatus, applyAsrFrameworkFromRust, syncAsrFrameworkFromLoaded, resolveModelKind } from "@/lib/modelState";
import { useAppStore, type EngineState } from "@/stores";
import { t } from "@/lib/i18n";

/** 字节数 → 人类可读（GB/MB） */
function formatSize(v: unknown): string {
  const n = typeof v === "number" ? v : 0;
  if (n <= 0) return "";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

/** 订阅 Sidecar 事件 → 驱动全局状态与运行日志。挂载一次。 */
export function useSidecarEvents() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlisten2: (() => void) | undefined;
    let disposed = false;

    void onSidecarEvent((payload) => {
      const store = useAppStore.getState();
      const status = String(payload.status ?? "");
      const model = typeof payload.model === "string" ? payload.model : "";

      // 旧请求的迟到事件（reqId 不匹配当前最新请求）→ 丢弃，避免旧终态覆盖新状态
      const reqId = typeof payload.reqId === "number" ? payload.reqId : null;
      if (reqId !== null && reqId !== useAppStore.getState().asr.loadReqId) {
        return;
      }

      // 事件自带 kind（Rust 权威）优先，缺省按模型名解析（TTS 等旧事件）
      const pk = payload.kind;
      const kindOf = (modelName: string): "asr" | "tts" | null =>
        pk === "asr" || pk === "tts" ? pk : resolveModelKind(modelName);

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
        status !== "tts_synthesizing" &&
        // 以下状态已有友好日志（case 里 addLog），跳过通用 JSON 日志避免重复
        status !== "model_loading" &&
        status !== "model_progress" &&
        status !== "model_ready" &&
        status !== "model_loaded" &&
        status !== "model_error" &&
        status !== "model_downloaded" &&
        status !== "model_download_cancelled" &&
        status !== "model_download_extracting" &&
        status !== "model_download_error" &&
        status !== "model_deleted" &&
        status !== "model_root_set" &&
        status !== "model_download_started" &&
        status !== "rust_log" &&
        status !== "runtime_download_progress" &&
        status !== "runtime_download_phase" &&
        status !== "runtime_installed" &&
        status !== "runtime_download_error" &&
        status !== "api_started" &&
        status !== "api_stopped"
      ) {
        const level = status.includes("error")
          ? "error"
          : status === "recognized" || status === "model_ready" || status === "api_started"
            ? "success"
            : "info";
        store.addLog(`[sidecar] ${JSON.stringify(payload)}`, level);
      }

      switch (status) {
        // ---- 推理框架下载（全局常住：切页/切窗口进度不丢）----
        case "runtime_download_progress": {
          const fw = typeof payload.framework === "string" ? payload.framework : "";
          const pct = typeof payload.progress === "number" ? payload.progress : 0;
          if (fw) {
            const cur = useAppStore.getState().runtimeDownload;
            const phase = cur?.framework === fw && cur?.phase ? cur.phase : "downloading";
            useAppStore.getState().setRuntimeDownload(fw, pct, null, phase);
          }
          break;
        }
        case "runtime_download_phase": {
          // 解压阶段等无百分比事件：保持 100%，切换状态文案（防 UI 假卡死）
          const fw = typeof payload.framework === "string" ? payload.framework : "";
          const phase = payload.phase === "extracting" ? "extracting" : "downloading";
          if (fw) {
            const cur = useAppStore.getState().runtimeDownload;
            if (phase === "extracting") {
              useAppStore.getState().setRuntimeDownload(fw, Math.max(cur?.pct ?? 100, 100), null, "extracting");
            }
          }
          break;
        }
        case "runtime_installed": {
          const fw = typeof payload.framework === "string" ? payload.framework : "";
          useAppStore.getState().setRuntimeDownload(null, 0);
          store.addLog(`[framework] ✅ ${fw} 下载完成`, "success");
          break;
        }
        case "runtime_download_error": {
          const fw = typeof payload.framework === "string" ? payload.framework : "";
          const msg = typeof payload.msg === "string" ? payload.msg : "未知错误";
          useAppStore.getState().setRuntimeDownload(null, 0, msg);
          store.addLog(`[framework] ❌ ${fw} 下载失败: ${msg}`, "error");
          break;
        }
        case "models_state":
          store.applyModelsState(payload);
          // 清理无效的 tts.model：不在已下载列表（或未下载）时重置为空，避免显示「未下载的选中模型」
          {
            const st = useAppStore.getState();
            const ttsSel = st.tts.model;
            if (ttsSel) {
              const item = st.models.items.find((i) => i.name === ttsSel);
              const isAsr = resolveModelKind(ttsSel) === "asr";
              if (!item || (item.kind === "tts" && item.state === "not_downloaded" && st.engines.tts.status !== "ready") || isAsr) {
                st.updateTts({ model: "" });
                st.setTtsModelStatus("idle");
              }
            }
            // 清单晚到时，用已加载模型对齐 ASR 框架标签（启动自动加载早于清单的场景）
            if (
              st.engines.asr.model &&
              (st.engines.asr.status === "ready" || st.engines.asr.status === "loading")
            ) {
              syncAsrFrameworkFromLoaded();
            }
          }
          break;
        case "model_download_started":
          store.addLog(`[download] ⬇ 开始下载 ${model}...`, "info");
          break;
        case "model_download_extracting":
          store.applyDownloadExtracting(model);
          store.addLog(`[download] 📦 ${model} 下载完成，正在解压安装...`, "info");
          break;
        case "model_downloaded":
          store.applyDownloadDone(status, model);
          store.addLog(
            `[download] ✅ ${model} 下载完成（${formatSize(payload.size_bytes)}）`,
            "success",
          );
          void sendToSidecar({ action: "list_models" });
          break;
        case "model_download_cancelled":
          store.applyDownloadDone(status, model);
          store.addLog(`[download] ⏹ ${model} 下载已取消`, "warn");
          void sendToSidecar({ action: "list_models" });
          break;
        case "model_download_error":
          store.applyDownloadDone(status, model);
          store.addLog(
            `[download] ❌ ${model} 下载失败: ${typeof payload.msg === "string" ? payload.msg : "未知错误"}`,
            "error",
          );
          void sendToSidecar({ action: "list_models" });
          break;
        case "model_deleted":
          store.addLog(
            `[model] 🗑 已删除 ${model}（释放 ${formatSize(payload.freed_bytes)}）`,
            "success",
          );
          void sendToSidecar({ action: "list_models" });
          break;
        case "model_root_set":
          store.addLog(
            `[model] 📂 模型目录已切换: ${typeof payload.path === "string" ? payload.path : ""}`,
            "info",
          );
          void sendToSidecar({ action: "list_models" });
          break;
        case "model_ready":
        case "model_loaded": {
          const device = typeof payload.device === "string" ? payload.device : null;
          const loadMs = typeof payload.load_ms === "number" ? payload.load_ms : null;
          store.addLog(
            `[model] ✅ ${model} 加载成功（${device || ""}${loadMs != null ? `, ${loadMs}ms` : ""}）`,
            "success",
          );
          if (device) {
            store.setLoadedModel(model || store.models.loadedModel || "", device);
            const kind = kindOf(model);
            if (kind) {
              applyEngineStatus(kind, "ready");
            }
            if (kind === "tts") {
              store.setTtsModelStatus("ready");
            } else if (kind === "asr") {
              store.updateAsr({ modelStatus: "ready", device: device as "cpu" | "cuda" });
              // 框架标签对齐：事件权威 framework 优先，清单兜底
              if (typeof payload.framework === "string") applyAsrFrameworkFromRust(payload.framework);
              else syncAsrFrameworkFromLoaded();
            }
          }
          break;
        }
        case "model_loading":
          store.addLog(`[model] ⏳ 正在加载 ${model}...`, "info");
          if (typeof payload.framework === "string") applyAsrFrameworkFromRust(payload.framework);
          applyEngineStatus(kindOf(model), "loading");
          break;
        case "model_progress": {
          // 加载阶段进度：unload / loading / ready —— 逐条记入运行日志，体现完整切换流程
          const stage = typeof payload.stage === "string" ? payload.stage : "loading";
          const kind = kindOf(model);
          if (kind) {
            useAppStore.getState().setEngineStatus(kind, {
              status: "loading",
              stage: stage as EngineState["stage"],
            });
          }
          const dev = typeof payload.device === "string" ? payload.device : "";
          if (stage === "unload") {
            store.addLog(`[model] 🛑 卸载旧引擎…`, "info");
          } else if (stage.startsWith("unload:")) {
            store.addLog(`[model] 🛑 卸载旧引擎: ${stage.slice("unload:".length)}`, "info");
          } else if (stage === "loading") {
            store.addLog(`[model] ⏳ 启动引擎中（${model}${dev ? `, ${dev}` : ""}）…`, "info");
          } else if (stage === "ready") {
            store.addLog(`[model] ✅ 引擎就绪（${model}）`, "success");
          } else if (stage) {
            store.addLog(`[model] 🔄 ${stage}`, "info");
          }
          break;
        }
        case "model_not_downloaded":
          applyEngineStatus(kindOf(model), "idle");
          break;
        case "model_error": {
          const errMsg =
            typeof payload.msg === "string"
              ? payload.msg
              : typeof payload.error === "string"
                ? payload.error
                : null;
          store.addLog(`[model] ❌ ${model} 加载失败: ${errMsg ?? "未知错误"}`, "error");
          applyEngineStatus(kindOf(model), "error", errMsg);
          break;
        }
        // ---- Rust 引擎侧日志（端口守卫/身份验证/引擎状态）----
        case "rust_log": {
          const lvl = String(payload.level ?? "info");
          const msg = String(payload.msg ?? "");
          if (!msg) break;
          const tgt = String(payload.target ?? "");
          const short = tgt.split("::").filter(Boolean).pop() || "rust";
          store.addLog(
            `[rust:${short}] ${msg}`,
            lvl === "error" ? "error" : lvl === "warn" ? "warn" : "info",
          );
          break;
        }
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
                  store.engines.asr.status !== "ready" ||
                  store.asr.device !== asrSnap.device
                ) {
                  applyEngineStatus("asr", "ready");
                  store.updateAsr({
                    modelStatus: "ready",
                    device: asrSnap.device as "cpu" | "cuda",
                  });
                  // 快照带出真实加载模型 → 对齐框架标签
                  if (asrSnap.model) {
                    const item = useAppStore.getState().models.items.find((i) => i.name === asrSnap.model);
                    if (item) applyAsrFrameworkFromRust(item.format === "onnx" ? "onnx" : "gguf");
                  }
                }
              } else if (!loaded && store.engines.asr.status === "ready") {
                applyEngineStatus("asr", "idle");
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
            applyEngineStatus(resolveModelKind(String(evictedModel)), "idle");
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
          const fileSize = typeof payload.size === "string" ? payload.size : undefined;
          const pendingTts = store.ttsTasks.find((t) => t.status === "synthesizing" && t.text === ttsText);
          if (pendingTts) {
            store.updateTtsTask(pendingTts.id, { status: "done", savedPath, fileSize });
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
          if (typeof payload.level === "number") {
            store.updateAsr({ volume: Math.min(1, Math.max(0, payload.level)) });
          }
          break;
        case "recognized":
          break;
        case "recognition_error": {
          const errMsg =
            typeof payload.error === "string"
              ? payload.error
              : typeof payload.msg === "string"
                ? payload.msg
                : t(store.locale, "log.recognitionFailed");
          store.addLog(`[asr] ${errMsg}`, "error");
          store.updateAsr({ status: "idle" });
          break;
        }
        case "api_started":
          store.addLog("[api] ✅ API 服务已启动", "success");
          store.updateApi({ enabled: true, endpoints: { asr: true, tts: true } });
          break;
        case "api_stopped":
          store.addLog("[api] ⏹ API 服务已停止", "info");
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
      } else if (s === "idle") {
        useAppStore.getState().updateAsr({ status: "idle" });
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
