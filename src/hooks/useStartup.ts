import { useEffect } from "react";
import { useAppStore } from "@/stores";
import { sendToSidecar } from "@/lib/tauri";
import { t } from "@/lib/i18n";

/** 热键变更 → 同步到 Rust */
export function useHotkeySync() {
  const hotkey = useAppStore((s) => s.asr.hotkey);
  useEffect(() => {
    if (!hotkey) return;
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke("set_hotkey", { hotkey }).catch(() => {});
    });
  }, [hotkey]);
}

/** 启动兜底：主动查询 GPU 和音频设备信息（不依赖事件推送） */
export function useStartupFallback() {
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
      // 模型清单：启动时拉一次，保证 models.items 就绪（事件处理依赖它判定模型种类）
      if (!s.models.items.length) {
        void sendToSidecar({ action: "list_models" });
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
export function useModelLoadTimeout() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.asr.modelStatus === "loading" && prev.asr.modelStatus !== "loading") {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const s = useAppStore.getState();
          if (s.asr.modelStatus === "loading") {
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
export function useStatusReconcile() {
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
