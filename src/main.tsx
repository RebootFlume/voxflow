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
  const asr0 = s0.asr;
  if (asr0.model) {
    const fw = asr0.framework === "onnx" ? "onnx" : "gguf";
    import("@/lib/tauri")
      .then(({ rustCheckRuntime }) => rustCheckRuntime())
      .catch(() => null)
      .then((runtimeCheck) => {
        const pkg = runtimeCheck?.packages?.find((p) => p.framework === fw);
        if (!runtimeCheck || pkg?.installed) {
          void import("./lib/modelLoader").then(({ loadAsrModel }) =>
            loadAsrModel(asr0.model, asr0.device).catch(() => {}),
          );
        } else {
          useAppStore.getState().addLog(
            `[init] 缺少推理框架 ${fw}（模型 ${asr0.model} 需要它），请到「推理框架」页下载`,
            "warn",
          );
          useAppStore.getState().setEngineStatus("asr", {
            framework: fw === "onnx" ? "sherpa" : "llama",
            model: asr0.model,
            status: "error",
            error: `缺少推理框架（${fw === "onnx" ? "sherpa-onnx" : "llama-server"}），请到「推理框架」页下载后重试`,
          });
        }
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

  // ⑤ 下发 sidecar 配置（镜像/代理）
  const { models } = useAppStore.getState();
  if (models.mirror || models.proxy !== undefined) {
    const endpoint =
      models.mirror === "cn" ? "https://hf-mirror.com" : models.mirror && models.mirror !== "official" ? models.mirror : "";
    void sendToSidecar({
      action: "bootstrap",
      mirror_endpoint: endpoint,
      proxy: models.proxy ?? "",
    }).catch(() => {});
  }
})();
