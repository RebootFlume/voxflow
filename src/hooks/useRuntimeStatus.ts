import { useEffect } from "react";
import { rustCheckRuntime } from "@/lib/tauri";
import { useAppStore } from "@/stores";

/**
 * 推理框架（libs）安装状态：全局检测 + 刷新时机。
 *
 * 刷新触发：挂载 / 框架下载结束 / 窗口聚焦 / 主动调用 refreshRuntime()。
 * 状态进 store（`runtime.packages`），供横幅、模型卡片、加载前置门禁共用——
 * 避免各组件各自 invoke 导致状态不一致。
 */
export function refreshRuntime() {
  return rustCheckRuntime()
    .then((r) => {
      useAppStore.getState().setRuntime(r.packages);
      return r.packages;
    })
    .catch(() => {
      useAppStore.getState().setRuntime(null);
      return null;
    });
}

export function useRuntimeStatus() {
  const downloadFramework = useAppStore((s) => s.runtimeDownload.framework);
  useEffect(() => {
    void refreshRuntime();
  }, []);
  // 框架下载结束（store 清空）→ 重新检测
  useEffect(() => {
    if (downloadFramework === null) void refreshRuntime();
  }, [downloadFramework]);
  useEffect(() => {
    const onFocus = () => void refreshRuntime();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}
