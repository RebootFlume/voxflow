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
import { rustLoadAsr, rustUnloadAsr, rustLoadTtsModel, rustUnloadTtsModel } from "@/lib/ipc";
import { engineOf, findModelItem, runtimeKeyOf, runtimeKeysOf, LOAD_REQ_PENDING } from "@/lib/modelState";
import { t } from "@/lib/i18n";

/**
 * 加载前置门禁：缺推理框架时不进入 loading、不 spawn 进程，直接给可读原因。
 * 返回 true = 放行；false = 已置错误并提示（调用方直接返回）。
 */
function runtimeGate(kind: "asr" | "tts", name: string): boolean {
  const s = useAppStore.getState();
  const item = findModelItem(s.models.items, name);
  // 模型清单可能尚未到达（list_models 事件晚于启动加载）→ ASR 回退到持久化的运行时 key 偏好。
  // 两者都没有时不拦（交给 Rust 报错），不再按 kind 硬编码格式。
  const keys = runtimeKeysOf(item);
  if (keys.length === 0 && kind === "asr" && s.asr.framework) keys.push(s.asr.framework);
  const pkgs = s.runtime.packages;
  if (!pkgs || keys.length === 0) return true; // 未检测到 / 无可判定的 key → 不拦（交给 Rust 报错）
  // 任一包就绪即放行：同一引擎的多个运行时包（如 CPU / CUDA 变体）共用同一个引擎
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
  const item = findModelItem(s.models.items, name);
  s.setEngineStatus("asr", { framework: engineOf(item), model: name, status: "loading", error: null });
  const fwKey = runtimeKeyOf(item) ?? s.asr.framework;
  s.updateAsr({
    model: name,
    device: device || "cuda",
    framework: fwKey,
    // 记住"这个框架下上次用的模型"：切走再切回来时恢复它（见 selectAsrFramework）
    ...(fwKey ? { lastModelByFramework: { ...s.asr.lastModelByFramework, [fwKey]: name } } : {}),
    modelStatus: "loading",
  });
  // rust_load_asr：立即返回 reqId（fire-and-forget，终态必达），
  // 状态由 model_loading/progress/ready/error 事件驱动（带 reqId 丢弃迟到事件）
  // 先写"在途"哨兵：model_loading 事件可能比 invoke 应答先到，那时 store 里还没有真实 reqId，
  // 不打这个标记首个事件会被事件过滤丢掉（阶段进度少一格、日志缺「⏳ 正在加载…」）。
  s.updateAsr({ loadReqId: LOAD_REQ_PENDING });
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
  // （cuda 设备会纠正到对应 CUDA 运行时包所在的框架标签）。
  const item = findModelItem(s.models.items, name);
  const fwKey = runtimeKeyOf(item);
  s.setEngineStatus("tts", { model: name, status: "loading", error: null });
  s.updateTts({
    model: name,
    device,
    ...(fwKey ? { framework: fwKey, lastModelByFramework: { ...s.tts.lastModelByFramework, [fwKey]: name } } : {}),
  });
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
 * 切换 TTS 推理框架 —— **只改选中，绝不碰引擎**。
 *
 * 加载/卸载只由"点模型卡片""点激活""点应用并重载"触发（见方案：统一加载策略）。
 * 之前这里会直接加载新框架下"第一个已下载"的模型：用户只是想看看另一个框架下有什么模型，
 * 就会被起一个 worker（首次加载 3–8s、吃内存/显存）。
 *
 * 选中项 = 该框架下**你上次选过的那个**（`lastModelByFramework`）；从没选过则谁都不选，
 * 也不替用户挑第一个。
 */
export function selectTtsFramework(framework: string): void {
  const s = useAppStore.getState();
  if (!framework || framework === s.tts.framework) return;
  s.updateTts({ framework, model: s.tts.lastModelByFramework[framework] ?? "" });
}

/** ASR 版：同样只改选中（切框架不加载、不卸载，也不替用户挑模型） */
export function selectAsrFramework(framework: string): void {
  const s = useAppStore.getState();
  if (!framework || framework === s.asr.framework) return;
  s.updateAsr({ framework, model: s.asr.lastModelByFramework[framework] ?? "" });
}

/** 启动自动加载只允许发生一次（清单可能在启动期到多次，重复加载无意义） */
let autoLoaded = false;
/** 配置未就绪时的重试定时器与次数（清单可能早于配置到达） */
let autoLoadRetryTimer: ReturnType<typeof setTimeout> | null = null;
let autoLoadRetries = 0;

/**
 * 启动时按开关自动加载"上次用过的模型" —— 由 `models_state`（清单落地）驱动调用。
 *
 * 为什么挂在清单事件上：持久化的模型可能已被删除/换机，无脑加载会让启动遮罩弹错误；
 * 拿到清单才能确认"它还在且已下载"。校验不过就清空选中 + 记一行日志，不加载。
 *
 * 整次运行只尝试一次（`autoLoaded`）：之后的清单刷新（切页、3s 轮询、窗口聚焦）不再触发加载。
 * ASR 默认自动加载（热键要求常驻），TTS 默认不加载。
 *
 * 前置条件：配置必须已恢复（`configLoaded`）—— 用户选的模型在 config.json 里，
 * 配置没读到时只能用默认值，那会把错的模型拉起来。
 */
export function autoLoadFromManifest(): void {
  if (autoLoaded) return;
  const s = useAppStore.getState();
  // 配置还没恢复 → 不能用默认模型去加载（用户选的模型在 config.json 里）。
  // 这里**不**消耗 autoLoaded：清单可能早于配置到达（主进程会自己推 models_state），
  // 所以稍后重试；正常路径是 main.tsx"先等配置、再请求清单"，第一次就能命中。
  if (!s.configLoaded) {
    if (autoLoadRetryTimer === null && autoLoadRetries < 40) {
      autoLoadRetries += 1;
      autoLoadRetryTimer = setTimeout(() => {
        autoLoadRetryTimer = null;
        autoLoadFromManifest();
      }, 150);
    }
    return;
  }
  // 只认"启动后第一份清单"：任一引擎已经不在 idle，说明用户已经动手（或上一份清单已处理过），
  // 此时再自动加载就是替用户做决定。`autoLoaded` 保证整次运行只尝试一次。
  if (s.engines.asr.status !== "idle" || s.engines.tts.status !== "idle") return;
  autoLoaded = true;

  const targets: { kind: "asr" | "tts"; model: string; device: string }[] = [];
  if (s.asr.autoLoad && s.asr.model) targets.push({ kind: "asr", model: s.asr.model, device: s.asr.device });
  if (s.tts.autoLoad && s.tts.model) targets.push({ kind: "tts", model: s.tts.model, device: s.tts.device });
  if (targets.length === 0) {
    // 本次没有模型要加载（自动加载开关关 / 没选模型）→ 告诉启动页"一闪而过"，别让它干等
    s.setAutoLoadState("none");
    return;
  }

  let started = false;
  let skipped = false;
  for (const t of targets) {
    const st = useAppStore.getState();
    const item = findModelItem(st.models.items, t.model);
    if (!item || item.state !== "downloaded") {
      skipped = true;
      st.addLog(`[model] 启动自动加载已跳过：${t.model} 不在已下载模型中（已清空选中）`, "warn");
      if (t.kind === "asr") {
        st.updateAsr({ model: "" });
        st.setEngineStatus("asr", { model: null, status: "idle", error: null });
      } else {
        st.updateTts({ model: "" });
        st.setEngineStatus("tts", { model: null, status: "idle", error: null });
        st.setTtsModelStatus("idle");
      }
      continue;
    }
    started = true;
    if (t.kind === "asr") void loadAsrModel(t.model, t.device).catch(() => {});
    else void loadTtsModel(t.model, t.device).catch(() => {});
  }
  // 判定结论交给启动页：started = 等引擎终态；skipped = 提示"未检测到模型"；都没有 = 一闪而过
  useAppStore.getState().setAutoLoadState(started ? "loading" : skipped ? "skipped" : "none");
}
