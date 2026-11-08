import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { sendToSidecar } from "./lib/ipc";
import { initPersistence } from "./lib/persistence";
import { registerCaptureBridge } from "./lib/capture";
import { useAppStore } from "./stores";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 注册采集 / 音频设备通道（主进程会主动下发指令）
registerCaptureBridge();

// 异步初始化：先恢复配置（决定加载哪个模型），历史/运行日志后台补齐，随后请求清单触发自动加载
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

  // ③ 运行时（推理框架）状态必须先备好：自动加载的前置门禁看 runtime.packages，
  //   没检测到 = 门禁放行（缺框架会变成后端加载失败，而不是可读的提示）。
  //   检测本身是纯文件检查，耗时可忽略，但必须排在请求清单之前 —— 否则门禁形同虚设。
  const { refreshRuntime } = await import("@/hooks/useRuntimeStatus");
  await refreshRuntime().catch(() => {});

  // ④ 启动自动加载：不在这一步直接加载 —— 先让 Rust 把清单发过来（⑤），
  //   清单落地时由 useSidecarEvents 调 autoLoadFromManifest() 做「模型还在不在」校验后再加载。
  //   为什么：持久化的模型可能已被删除/换机，无脑加载只会让启动遮罩弹一个错误。

  // ⑤ 数据根：Rust 判定便携/安装 → 设置模型目录展示值（下载/列表全走 Rust 数据根），
  //   并固定请求一次清单（启动自动加载的校验依赖它，不再只在"数据根变化"时才请求）
  import("@/lib/ipc")
    .then(({ rustGetDataRootInfo }) => rustGetDataRootInfo())
    .then((info) => {
      const st = useAppStore.getState();
      if (info.model_root && info.model_root !== st.models.modelRoot) {
        st.setModelRootLocal(info.model_root);
        st.addLog(
          `[init] 数据根 ${info.portable ? "便携(exe旁)" : "AppData"}: ${info.model_root}`,
          "info",
        );
      }
    })
    .catch(() => {})
    .finally(() => {
      void sendToSidecar({ action: "list_models" }).catch(() => {});
    });

  // ⑥ 下发 sidecar 配置（下载代理 / HF token；两者皆空即直连，无需下发）
  const { models } = useAppStore.getState();
  if (models.proxy || models.huggingfaceToken) {
    void sendToSidecar({
      action: "bootstrap",
      proxy: models.proxy ?? "",
      hf_token: models.huggingfaceToken ?? "",
    }).catch(() => {});
  }
})();
