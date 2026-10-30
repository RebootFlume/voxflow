import { useEffect } from "react";
import { rustGetVramStatus } from "@/lib/ipc";
import { useAppStore } from "@/stores";

/** 框架占用：仅收集有意义的正数（缺失/0/null 视为未加载，不显示空行） */
function collectFrameworkVram(
  raw: Record<string, { mb: number; source?: string } | null> | null | undefined,
): Record<string, { mb: number; source: string }> {
  const out: Record<string, { mb: number; source: string }> = {};
  for (const [key, v] of Object.entries(raw ?? {})) {
    const mb = v?.mb;
    if (typeof mb === "number" && mb > 0) out[key] = { mb, source: v?.source ?? "" };
  }
  return out;
}

/**
 * 全局显存监控轮询器。
 *
 * 在 App 根挂载一次（不随面板组件生命周期启停），每 15s 轮询一次
 * 显存状态写入 store。任意组件通过 store 读共享数据，避免：
 *   - 每次进入页面重复启动 nvidia-smi 查询（快速切页时的卡顿）
 *   - 多个组件各自轮询造成重复请求
 *   - 转写等高负载时轮询干扰（转写中暂停，避免 IPC 竞争）
 *
 * 为什么从 10s 放宽到 15s：主进程的 WMI 查询实测 3.3s（PowerShell + 两次 CIM）。
 * 即使已异步化，Windows 每次起进程本身仍有主线程开销（杀软更久）⇒ 频率越高越容易
 * 「时不时点一下卡一下」。15s 与主进程 20s TTL 配合 ⇒ 最多两轮才真查一次；
 * 窗口隐藏到托盘时直接不轮询（没人看，不必花这个 CPU）。
 */
const POLL_INTERVAL_MS = 15_000

export function useVramPoller() {
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;

    const poll = () => {
      // 窗口隐藏到托盘 / 最小化：不查（重新可见时会立刻补一次）
      if (typeof document !== "undefined" && document.hidden) return;
      // 转写/合成进行中暂停轮询（避免与推理竞争，界面更流畅）
      const s = useAppStore.getState();
      const transcribing = s.transcribeTasks?.some((t) => t.status === "transcribing") ?? false;
      const synthesizing = s.ttsTasks?.some((t) => t.status === "synthesizing") ?? false;
      if (transcribing || synthesizing) return;

      rustGetVramStatus()
        .then((r) => {
          if (!alive) return;
          useAppStore.getState().setVram({
            total: r.total_mb ?? 0,
            used: r.used_mb ?? 0,
            // 框架占用：Rust 按框架 id 下发键（旧键 llama/sherpa 可能并存）→ 原样收集，前端不枚举
            frameworks: collectFrameworkVram(r.frameworks),
          });
        })
        .catch(() => {});
    };

    const onVisibilityChange = () => {
      if (!document.hidden) poll();
    };

    poll();
    timer = window.setInterval(poll, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      alive = false;
      if (timer) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
}
