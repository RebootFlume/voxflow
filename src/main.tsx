import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { sendToSidecar } from "./lib/tauri";
import { initPersistence } from "./lib/persistence";
import { useAppStore } from "./stores";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 异步初始化：先拉起模型（不阻塞），再异步补全 config/history/logs
(async () => {
  // ① 第一步：恢复持久化配置（config.json）+ 监听变化
  await initPersistence();
  useAppStore.getState().addLog("🚀 VoxFlow 启动", "info");

  // ② 自动启用 Rust 引擎
  const s0 = useAppStore.getState();
  if (!s0.useRustEngine) {
    s0.setUseRustEngine(true);
    s0.addLog("[init] auto-enable Rust engine", "info");
  }

  // ③ 加载 ASR 模型
  // 加载入口自带「运行时前置门禁」：缺框架时直接给可读错误 + 全局横幅，
  // 不进入 loading（此前这里重复实现了一遍框架检查，失败又只写日志，用户看不到）。
  const asr0 = s0.asr;
  if (asr0.model) {
    void Promise.all([
      import("@/hooks/useRuntimeStatus"),
      import("./lib/modelLoader"),
    ]).then(async ([{ refreshRuntime }, { loadAsrModel }]) => {
      // 先让门禁拿到框架状态，再决定是否发起加载
      await refreshRuntime();
      void loadAsrModel(asr0.model, asr0.device).catch(() => {});
    });
  }

  // ④ 数据根：Rust 判定便携/安装 → 设置模型目录展示值（下载/列表全走 Rust 数据根）
  import("@/lib/tauri")
    .then(({ rustGetDataRootInfo }) => rustGetDataRootInfo())
    .then((info) => {
      const st = useAppStore.getState();
      if (info.model_root && info.model_root !== st.models.modelRoot) {
        st.setModelRootLocal(info.model_root);
        st.addLog(
          `[init] 数据根 ${info.portable ? "便携(exe旁)" : "AppData"}: ${info.model_root}`,
          "info",
        );
        import("@/lib/tauri")
          .then(({ sendToSidecar }) =>
            sendToSidecar({ action: "list_models" }).catch(() => {}),
          )
          .catch(() => {});
      }
    })
    .catch(() => {});

  // ⑤ 下发 sidecar 配置（镜像/代理/HF token）
  const { models } = useAppStore.getState();
  if (models.mirror || models.proxy !== undefined || models.huggingfaceToken) {
    const endpoint =
      models.mirror === "cn" ? "https://hf-mirror.com" : models.mirror && models.mirror !== "official" ? models.mirror : "";
    void sendToSidecar({
      action: "bootstrap",
      mirror_endpoint: endpoint,
      proxy: models.proxy ?? "",
      hf_token: models.huggingfaceToken ?? "",
    }).catch(() => {});
  }
})();
