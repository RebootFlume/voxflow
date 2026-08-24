import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { sendToSidecar } from "./lib/tauri";
import { initPersistence } from "./lib/persistence";
import { useAppStore } from "./stores/app";
import { loadAsrModel, loadTtsModel } from "./lib/modelLoader";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 异步初始化：读取 config.json + history + 下发 sidecar 配置 + 恢复模型
(async () => {
  await initPersistence();

  const { asr, tts, models } = useAppStore.getState();
  if (models.modelRoot || models.mirror || models.proxy !== undefined) {
    const endpoint =
      models.mirror === "cn" ? "https://hf-mirror.com" : models.mirror && models.mirror !== "official" ? models.mirror : "";
    void sendToSidecar({
      action: "bootstrap",
      ...(models.modelRoot ? { model_root: models.modelRoot } : {}),
      mirror_endpoint: endpoint,
      proxy: models.proxy ?? "",
    }).catch(() => {});
  }

  // 恢复上次的模型：直接走 Rust 原生加载（不再经过已废弃的 sidecar set_model）
  // 旧 config 的 useRustEngine 可能是 false（Python 时代遗留），这里自动纠偏为 true 并尝试加载；
  // asr.tts 均会经历 loading → ready/error，并在 modelLoader 里记 addLog，失败原因可在「历史-运行日志」查看
  const st0 = useAppStore.getState();
  if (!st0.useRustEngine) {
    st0.setUseRustEngine(true);
    st0.addLog("[init] auto-enable Rust engine (migrated from Python)", "info");
  }
  if (asr.model) {
    void loadAsrModel(asr.model, asr.device).catch(() => {});
  }
  if (tts.model) {
    void loadTtsModel(tts.model, tts.device).catch(() => {});
  }
})();
