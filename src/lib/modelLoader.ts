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
import { rustLoadAsr, rustGetStatus, rustUnloadAsr, rustLoadTtsModel, rustSwitchE2eTtsModel, rustUnloadTtsModel } from "@/lib/tauri";
import type { EngineFramework } from "@/stores/types";

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

/** 从 kind + 模型名推断框架（仅 TTS 用；ASR 已统一走 Rust 注册表） */
export function frameworkFor(kind: "asr" | "tts", name: string): EngineFramework {
  if (kind === "asr") {
    return asrFrameworkForDisplay(name);
  }
  // TTS：E2E 模型 → sherpa；其他 → torch
  if (/^(kokoro|matcha|zipvoice|pocket|supertonic|kitten)/i.test(name)) return "sherpa";
  return "torch";
}

/** 加载 ASR 引擎（统一入口：路由在 Rust，前端只传模型名+设备） */
export function loadAsrModel(name: string, device: string): Promise<void> {
  const s = useAppStore.getState();
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

/** 查询真实引擎是否就绪（状态快照） */
export function checkAsrServer(): Promise<boolean> {
  return rustGetStatus().then(
    (r) => Boolean((r.asr as { loaded?: boolean } | undefined)?.loaded),
    () => false,
  );
}

/** 加载 TTS 模型（model + device 一并写入，统一置 loading） */
export function loadTtsModel(name: string, device: string): Promise<void> {
  const s = useAppStore.getState();
  // 全局门禁：任一引擎加载中禁止再发起加载
  if (s.engines.asr.status === "loading" || s.engines.tts.status === "loading") {
    return Promise.resolve();
  }
  const framework = frameworkFor("tts", name);
  s.setEngineStatus("tts", { framework, model: name, status: "loading", error: null });
  s.updateTts({ model: name, device });
  s.setTtsModelStatus("loading"); // 兼容旧 UI，语义改为「UI 选中」

  const isE2eId = /^(kokoro|matcha|zipvoice|pocket|supertonic|kitten)/i.test(name);
  const op = isE2eId ? rustSwitchE2eTtsModel(name, device) : rustLoadTtsModel(name, device);
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
