/**
 * 模型加载统一入口 —— 状态链路的「单一真源」。
 *
 * 设计原则：无论从哪个 UI 发起加载（ASR 面板 / TTS 面板 / 模型管理页），
 * 都必须调用这里，统一完成：
 *   1. 乐观置 engines[kind] = loading（立即反馈，不等事件回传）
 *   2. 调用 Rust 加载
 *   3. 按结果回写 engines ready / error（并记日志）
 *
 * 状态写入点唯一：engines（modelsSlice），tts.model / asr.model 仅表示 UI 选中。
 */
import { useAppStore } from "@/stores";
import { rustLoadAsr, rustUnloadAsr, rustLoadTtsModel, rustUnloadTtsModel } from "@/lib/tauri";
import { engineOf, runtimeKeyOf } from "@/lib/modelState";
import { t } from "@/lib/i18n";

/**
 * 加载前置门禁：缺推理框架时不进入 loading、不 spawn 进程，直接给可读原因。
 * 返回 true = 放行；false = 已置错误并提示（调用方直接返回）。
 */
function runtimeGate(kind: "asr" | "tts", name: string): boolean {
  const s = useAppStore.getState();
  const item = s.models.items.find((i) => i.name === name);
  // 模型清单可能尚未到达（list_models 事件晚于启动加载）→ ASR 回退到持久化的运行时 key 偏好。
  // 两者都没有时不拦（交给 Rust 报错），不再按 kind 硬编码格式。
  const key = runtimeKeyOf(item) ?? (kind === "asr" ? s.asr.framework : null);
  const pkgs = s.runtime.packages;
  if (!pkgs || !key) return true; // 未检测到 / 无可判定的 key → 不拦（交给 Rust 报错）
  const pkg = pkgs.find((p) => p.framework === key);
  if (!pkg || pkg.state === "ready") return true;

  const msg = t(s.locale, "runtime.gate.blocked", { name: pkg.name });
  s.setEngineStatus(kind, { model: name, status: "error", error: msg });
  if (kind === "asr") s.updateAsr({ modelStatus: "error" });
  else s.setTtsModelStatus("error");
  s.addLog(`[model] ${msg}`, "error");
  return false;
}

/** 加载 ASR 引擎（统一入口：路由在 Rust，前端只传模型名+设备） */
export function loadAsrModel(name: string, device: string): Promise<void> {
  const s = useAppStore.getState();
  // 前置门禁：缺框架直接给结论
  if (!runtimeGate("asr", name)) return Promise.resolve();
  // 乐观 loading（立即反馈）；框架标识全部来自 Rust 下发的清单字段，不做格式→引擎推导
  const item = s.models.items.find((i) => i.name === name);
  s.setEngineStatus("asr", { framework: engineOf(item), model: name, status: "loading", error: null });
  s.updateAsr({
    model: name,
    device: device || "cuda",
    framework: runtimeKeyOf(item) ?? s.asr.framework,
    modelStatus: "loading",
  });
  // rust_load_asr：立即返回 reqId（fire-and-forget，终态必达），
  // 状态由 model_loading/progress/ready/error 事件驱动（带 reqId 丢弃迟到事件）
  return rustLoadAsr(name, device).then(
    (r) => {
      const st = useAppStore.getState();
      if (typeof r?.reqId === "number") {
        st.updateAsr({ loadReqId: r.reqId });
      }
    },
    (e) => {
      const st = useAppStore.getState();
      st.setEngineStatus("asr", { status: "error", error: String(e) });
      st.updateAsr({ modelStatus: "error", loadReqId: 0 }); // 兼容旧 UI 徽章
      st.addLog(`[model] ASR 加载失败: ${String(e)}`, "error");
    },
  );
}

/** 卸载 ASR 引擎（llama/sherpa 统一走 Rust） */
export function unloadAsrModel(): Promise<void> {
  const s = useAppStore.getState();
  s.resetEngine("asr");
  s.updateAsr({ modelStatus: "idle", loadReqId: 0 });
  return rustUnloadAsr().then(
    () => useAppStore.getState().addLog(`[model] ⏹ ASR 引擎已卸载`, "info"),
    () => {},
  );
}

/** 加载 TTS 模型（model + device 一并写入，统一置 loading） */
export function loadTtsModel(name: string, device: string): Promise<void> {
  const s = useAppStore.getState();
  // 全局门禁：任一引擎加载中禁止再发起加载
  if (s.engines.asr.status === "loading" || s.engines.tts.status === "loading") {
    return Promise.resolve();
  }
  // 前置门禁：缺框架直接给结论（不进 loading、不起进程）
  if (!runtimeGate("tts", name)) return Promise.resolve();
  // 框架不由前端推断：乐观阶段不写 framework，等 model_ready 事件的权威值
  s.setEngineStatus("tts", { model: name, status: "loading", error: null });
  s.updateTts({ model: name, device });
  s.setTtsModelStatus("loading"); // 兼容旧 UI，语义改为「UI 选中」

  const op = rustLoadTtsModel(name, device);
  return op.then(
    () => {
      const st = useAppStore.getState();
      st.setEngineStatus("tts", { status: "ready" });
      st.setTtsModelStatus("ready"); // 兼容旧 UI 徽章
    },
    (e) => {
      const st = useAppStore.getState();
      st.setEngineStatus("tts", { status: "error", error: String(e) });
      st.setTtsModelStatus("error"); // 兼容旧 UI 徽章
      st.addLog(`[model] TTS 加载失败: ${String(e)}`, "error");
    },
  );
}

/** 卸载 TTS 模型（释放引擎，可随后删除模型） */
export function unloadTtsModel(): Promise<void> {
  const s = useAppStore.getState();
  const name = s.engines.tts.model;
  s.resetEngine("tts");
  s.setTtsModelStatus("idle");
  return rustUnloadTtsModel().then(
    () => useAppStore.getState().addLog(`[model] ⏹ TTS 模型已卸载（${name ?? ""}）`, "info"),
    () => {},
  );
}
