import { useEffect } from "react";
import { rustGetVramStatus } from "@/lib/tauri";
import { useAppStore } from "@/stores";

/**
 * 全局显存监控轮询器。
 *
 * 在 App 根挂载一次（不随面板组件生命周期启停），每 10s 轮询一次
 * 显存状态写入 store。任意组件通过 store 读共享数据，避免：
 *   - 每次进入页面重复启动 nvidia-smi 查询（快速切页时的卡顿）
 *   - 多个组件各自轮询造成重复请求
 *   - 转写等高负载时轮询干扰（转写中暂停，避免 IPC 竞争）
 *
 * 说明：Rust 端 get_vram_status 已改为 spawn_blocking 异步执行
 * （powershell/nvidia-smi/目录遍历不占主线程），这里再降低频率 + 转写暂停双保险。
 */
export function useVramPoller() {
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;

    const poll = () => {
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
            llama: r.frameworks?.llama?.mb ?? null,
            sherpa: r.frameworks?.sherpa?.mb ?? null,
          });
        })
        .catch(() => {});
    };

    poll();
    timer = window.setInterval(poll, 10_000);
    return () => {
      alive = false;
      if (timer) window.clearInterval(timer);
    };
  }, []);
}
