import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { sendToSidecar } from "./lib/tauri";
import { initPersistence } from "./lib/persistence";
import { useAppStore } from "./stores";
import { loadAsrModel } from "./lib/modelLoader";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 异步初始化：先拉起模型（不阻塞），再异步补全 config/history/logs
(async () => {
  // ① 第一步：立即触发 ASR 加载（zustand persist 同步读 localStorage，asr.model 立即可得）
  //    —— 让启动 Splash 第一时间显示加载中，而非等 initPersistence 的 3 次 IPC 往返
  const s0 = useAppStore.getState();
  if (!s0.useRustEngine) {
    s0.setUseRustEngine(true);
    s0.addLog("[init] auto-enable Rust engine (migrated from Python)", "info");
  }
  const asr0 = s0.asr;
  // ASR：走 llama-server 子进程（GGUF 路线），启动时自动拉起常驻服务
  // （TTS 模型按需加载：用户切换到 TTS 页或第一次合成时才加载，避免启动占用 VRAM）
  if (asr0.model) {
    void loadAsrModel(asr0.model, asr0.device).catch(() => {});
  } else {
    // 空启动：配置无默认模型（首次安装）→ 不自动加载任何模型，避免加载不存在的默认模型
    // 由 StartupSplash 展示「未检测到模型」并自动进入主界面，引导用户到模型页下载
    useAppStore.getState().addLog("[init] no persisted model, booting empty (download in Models panel)", "info");
  }

  // ② 第二步：异步补全持久化（config.json 迁移 + history + runtime logs）
  await initPersistence();
  useAppStore.getState().addLog("🚀 VoxFlow 启动", "info");

  // ③ 第三步：下发 sidecar 配置（镜像/代理）
  const { models } = useAppStore.getState();
  if (models.mirror || models.proxy !== undefined) {
    const endpoint =
      models.mirror === "cn" ? "https://hf-mirror.com" : models.mirror && models.mirror !== "official" ? models.mirror : "";
    void sendToSidecar({
      action: "bootstrap",
      // 不再传 model_root：数据根由 Rust setup 统一决定（便携/安装）
      mirror_endpoint: endpoint,
      proxy: models.proxy ?? "",
    }).catch(() => {});
  }
})();
