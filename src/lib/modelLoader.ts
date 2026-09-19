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
import type { EngineFramework, ModelFramework } from "@/stores/types";
import { runtimeKeyForFormat } from "@/hooks/useRuntimeStatus";
import { t } from "@/lib/i18n";

/**
 * ASR 框架「展示」映射（仅 UI 标签用）。
 * 注意：路由一律由 Rust 注册表决定（rust_load_asr 内部按模型 format 分流），
 * 这里不再参与任何加载决策 —— 不按名字猜框架。
 */
function asrFrameworkForDisplay(name: string): EngineFramework {
  const item = useAppStore.getState().models.items.find((i) => i.name === name);
  if (item?.format === "onnx") return "sherpa";
  return "llama";
}

/** 推理框架（由模型清单 kind + format 决定；前端不再按名字猜框架） */
export function frameworkForModel(item: { kind: "asr" | "tts"; format: ModelFramework }): EngineFramework {
  if (item.format === "gguf") return "llama";
  if (item.format === "onnx") return "sherpa";
  return "torch";
}


/**
 * 加载前置门禁：缺推理框架时不进入 loading、不 spawn 进程，直接给可读原因。
 * 返回 true = 放行；false = 已置错误并提示（调用方直接返回）。
 */
function runtimeGate(kind: "asr" | "tts", name: string): boolean {
  const s = useAppStore.getState();
  const item = s.models.items.find((i) => i.name === name);
  // 模型清单可能尚未到达（list_models 事件晚于启动加载）→ 回退到持久化的框架偏好：
  // ASR 用 asr.framework（gguf/onnx），TTS 现全部为 onnx。没有回退时门禁会静默放行，
  // 又回到"加载失败只写日志"的老路（实机验证发现的漏洞）。
  const key =
    runtimeKeyForFormat(item?.format) ??
    (kind === "asr" ? (s.asr.framework === "onnx" ? "onnx" : "gguf") : "onnx");
  const pkgs = s.runtime.packages;
  if (!pkgs) return true; // 未检测到 → 不拦（交给 Rust 报错）
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
  // 乐观 loading（立即反馈）；框架仅用于展示
  const fw = asrFrameworkForDisplay(name);
  s.setEngineStatus("asr", { framework: fw, model: name, status: "loading", error: null });
  s.updateAsr({
    model: name,
    device: device || "cuda",
    framework: fw === "sherpa" ? "onnx" : "gguf",
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
