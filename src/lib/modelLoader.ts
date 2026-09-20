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
import { belongsToFramework, engineOf, runtimeKeyOf, runtimeKeysOf } from "@/lib/modelState";
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
  const keys = runtimeKeysOf(item);
  if (keys.length === 0 && kind === "asr" && s.asr.framework) keys.push(s.asr.framework);
  const pkgs = s.runtime.packages;
  if (!pkgs || keys.length === 0) return true; // 未检测到 / 无可判定的 key → 不拦（交给 Rust 报错）
  // 任一包就绪即放行：PyTorch 的 cpu / cuda130 两个包共用同一个引擎
  const candidates = keys.map((k) => pkgs.find((p) => p.framework === k)).filter(Boolean);
  if (candidates.length === 0 || candidates.some((p) => p!.state === "ready")) return true;
  const blocked = candidates.find((p) => p!.state !== "ready")!;

  const msg = t(s.locale, "runtime.gate.blocked", { name: blocked.name });
  s.setEngineStatus(kind, { model: name, status: "error", error: msg });
  if (kind === "asr") s.updateAsr({ modelStatus: "error" });
  else s.setTtsModelStatus("error");
  s.addLog(`[model] ${msg}`, "error");
  return false;
}

/**
 * 全局加载门禁：任一引擎加载中禁止再发起加载。
 *
 * 为什么要有：Rust 侧 ASR registry 与 TtsRegistry 各自互斥，并发加载本身不会互相改状态，
 * 但 ASR 的显存预检（`rust_check_vram`）是**加载前读一次**全卡占用 —— 读完之后另一个引擎才开始
 * 加载的话，那个"可用显存"就是过期数字，两个模型加起来可能超显存。所以串行化加载。
 *
 * 这里只做竞态兜底：界面在加载中已禁用入口（`selectLoadingKind`）。真命中时写日志而不是
 * 静默 return —— 点了没反应会让用户以为程序卡了，且排查时毫无线索。
 */
function blockedByLoading(target: "asr" | "tts"): boolean {
  const s = useAppStore.getState();
  const busy = s.engines.asr.status === "loading" ? "asr" : s.engines.tts.status === "loading" ? "tts" : null;
  if (!busy) return false;
  const msg = t(s.locale, "model.gate.busy", { busy: busy.toUpperCase(), target: target.toUpperCase() });
  s.addLog(`[model] ${msg}`, "warn");
  return true;
}

/** 加载 ASR 引擎（统一入口：路由在 Rust，前端只传模型名+设备） */
export function loadAsrModel(name: string, device: string): Promise<void> {
  const s = useAppStore.getState();
  // 全局门禁：与 TTS 共用一处实现，两个方向都拦
  if (blockedByLoading("asr")) return Promise.resolve();
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
  if (!name) {
    // 未选中模型：只记设备偏好。带空模型名进后端只会换来一个无意义的"找不到模型"错误
    // （框架下没有已下载模型时 `tts.model` 就是空，此时点设备下拉会走到这里）
    s.updateTts({ device });
    return Promise.resolve();
  }
  // 全局门禁：与 ASR 共用一处实现，两个方向都拦（命中写日志，不静默丢弃）
  if (blockedByLoading("tts")) return Promise.resolve();
  // 前置门禁：缺框架直接给结论（不进 loading、不起进程）
  if (!runtimeGate("tts", name)) return Promise.resolve();
  // 乐观阶段先把框架偏好切到这个模型的框架：否则过滤后的列表会把刚点中的模型自己藏起来
  // （框架≠模型所属框架），点完瞬间卡片消失、加载完成又冒出来。最终以 model_ready 事件为准
  // （cuda 设备会纠正到 pytorch-cuda130 所在的那个框架标签）。
  const item = s.models.items.find((i) => i.name === name);
  s.setEngineStatus("tts", { model: name, status: "loading", error: null });
  s.updateTts({ model: name, device, ...(runtimeKeyOf(item) ? { framework: runtimeKeyOf(item)! } : {}) });
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

/**
 * 切换 TTS 推理框架 —— 框架与模型必须成对变化。
 *
 * 只改框架偏好会让界面自相矛盾：列表按新框架过滤后看不到任何模型，而"当前"
 * 仍是旧框架的模型（用户看到的就是"框架换了、模型没跟着换"）。所以这里：
 *   1. 该框架下有已下载模型 → 直接加载清单里的第一个（顺序即优先级），模型跟着框架走；
 *   2. 该框架下没有已下载模型 → 卸载当前引擎并清空选中，让界面如实显示"该框架下没有模型"。
 * 同模型已就绪时只改偏好，不重启引擎（幂等）。
 */
export function switchTtsFramework(framework: string): void {
  const s = useAppStore.getState();
  if (!framework || framework === s.tts.framework) return;
  const target = s.models.items.find(
    (i) => i.kind === "tts" && i.state === "downloaded" && belongsToFramework(i, framework),
  );
  if (!target) {
    s.updateTts({ framework, model: "" });
    s.setTtsModelStatus("idle");
    if (s.engines.tts.status !== "idle") {
      s.addLog(`[model] 框架 ${framework} 下没有已下载模型，已卸载当前 TTS 模型`, "warn");
      void unloadTtsModel();
    }
    return;
  }
  if (target.name === s.tts.model && s.engines.tts.status === "ready") {
    s.updateTts({ framework });
    return;
  }
  void loadTtsModel(target.name, s.tts.device);
}
