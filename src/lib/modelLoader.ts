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
import { rustLoadTtsModel, rustStartLlamaServer, rustStopLlamaServer, rustLlamaServerStatus, rustSwitchE2eTtsModel, rustUnloadTtsModel } from "@/lib/tauri";
import type { EngineFramework } from "@/stores/types";

/** 从模型名推断框架 */
export function frameworkOfModel(name: string): EngineFramework {
  const lower = name.toLowerCase();
  if (lower.includes("sensevoice") || lower.includes("paraformer")) return "sherpa";
  if (/^(kokoro|matcha|zipvoice|pocket|supertonic|kitten)/i.test(lower)) return "sherpa";
  if (lower.includes("qwen3-asr") || lower.includes("qwen3")) return "llama";
  return "torch";
}

/** 从 kind + 模型名推断框架 */
export function frameworkFor(kind: "asr" | "tts", name: string): EngineFramework {
  if (kind === "asr") {
    // ASR：GGUF → llama，ONNX（SenseVoice/Paraformer）→ sherpa
    const item = useAppStore.getState().models.items.find((i) => i.name === name);
    if (item?.format === "onnx") return "sherpa";
    return "llama";
  }
  // TTS：E2E 模型 → sherpa；其他 → torch
  if (/^(kokoro|matcha|zipvoice|pocket|supertonic|kitten)/i.test(name)) return "sherpa";
  return "torch";
}

/** 加载 ASR 引擎（llama-server 子进程 / sherpa websocket server） */
export function loadAsrModel(name: string, device: string): Promise<void> {
  const s = useAppStore.getState();
  const framework = frameworkFor("asr", name);
  s.setEngineStatus("asr", { framework, model: name, status: "loading", error: null });
  s.updateAsr({ model: name, device: device || "cuda", framework: framework === "sherpa" ? "onnx" : "gguf" });

  // sherpa ASR → sidecar load_model（lib.rs 按 kind=asr + Onnx 路由到 sherpa 引擎）
  const op = framework === "sherpa"
    ? import("@/lib/tauri").then(({ sendToSidecar }) =>
        sendToSidecar({ action: "load_model", model: name, device }))
    : rustStartLlamaServer();

  return op.then(
    () => {
      const st = useAppStore.getState();
      st.setEngineStatus("asr", { status: "ready" });
      st.updateAsr({ modelStatus: "ready" }); // 兼容旧 UI 徽章
    },
    (e) => {
      const st = useAppStore.getState();
      st.setEngineStatus("asr", { status: "error", error: String(e) });
      st.updateAsr({ modelStatus: "error" }); // 兼容旧 UI 徽章
      st.addLog(`[model] ASR 加载失败: ${String(e)}`, "error");
    },
  );
}

/** 卸载 ASR 引擎（停止 llama-server / 杀 sherpa websocket server） */
export function unloadAsrModel(): Promise<void> {
  const s = useAppStore.getState();
  const framework = s.engines.asr.framework;
  s.resetEngine("asr");
  const op = framework === "sherpa"
    ? import("@/lib/tauri").then(({ rustUnloadSherpaAsr }) => rustUnloadSherpaAsr())
    : rustStopLlamaServer();
  return op.then(
    () => useAppStore.getState().addLog(`[model] ⏹ ASR 引擎已卸载（${framework ?? "llama"}）`, "info"),
    () => {},
  );
}

/** 查询 llama-server 是否已就绪 */
export function checkAsrServer(): Promise<boolean> {
  return rustLlamaServerStatus().then(
    (r) => Boolean(r.loaded),
    () => false,
  );
}

/** 加载 TTS 模型（model + device 一并写入，统一置 loading） */
export function loadTtsModel(name: string, device: string): Promise<void> {
  const s = useAppStore.getState();
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
