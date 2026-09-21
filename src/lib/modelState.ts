/**
 * 模型状态「判定」与「应用」的收敛层。
 *
 * 状态域分离：
 * - items[]：只管「下载」状态（not_downloaded / downloading / downloaded）
 * - engines：只管「加载」状态（framework + model + status + error）
 *
 * 「是否已加载」统一依据 engines（status === "ready" 且 model 匹配），
 * 不再用脆弱的 model 名对比，也不依赖 tts.model / asr.model 的「选中」值。
 */
import { useAppStore, type ModelItemState } from "@/stores";

export type ModelKind = "asr" | "tts";

/** 清单里按展示名 / 引擎目录名归一化找模型（与 Rust `spec::find` 的别名集合一致） */
export function ttsModelInfoOf(
  items: ModelItemState[],
  model: string,
): ModelItemState | null {
  if (!model) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
  return (
    items.find(
      (m) => m.kind === "tts" && (norm(m.name) === norm(model) || norm(m.path) === norm(model)),
    ) ?? null
  );
}

/**
 * 描述符能力：该模型是否支持语音克隆（`voice_mode` 优先，旧 payload 退回 `supports_clone`）。
 *
 * **判据只此一处**：音色工作区的按钮门控与「模型就绪时恢复克隆音色」必须同源，
 * 否则会出现「页面说模型不支持克隆、恢复路径却去下发参考音」这种必然失败的组合。
 */
export function supportsClone(info: ModelItemState | null | undefined): boolean {
  if (!info) return false;
  const mode = info.voice_mode?.type;
  return mode === "clone" || mode === "preset_and_clone" || info.supports_clone === true;
}

/** 非 React 上下文（事件回调）用：按当前清单判断某 TTS 模型是否支持克隆 */
export function ttsSupportsClone(model: string): boolean {
  return supportsClone(ttsModelInfoOf(useAppStore.getState().models.items, model));
}

/** 运行时包 key：Rust 下发的 runtime_key 优先，缺失回退既有 format（不再按格式枚举/映射） */
export function runtimeKeyOf(
  item: Pick<ModelItemState, "runtime_key" | "format"> | undefined | null,
): string | null {
  if (!item) return null;
  return item.runtime_key || item.format || null;
}

/**
 * 该模型可用的全部运行时包 key（Rust 下发 runtime_keys）。
 *
 * PyTorch 有 cpu / cuda130 两个包，任一就绪即可加载 —— 单靠 runtime_key 会误判为缺框架。
 * 未下发时回退单 key，保持既有行为。
 */
export function runtimeKeysOf(
  item: Pick<ModelItemState, "runtime_keys" | "runtime_key" | "format"> | undefined | null,
): string[] {
  if (!item) return [];
  if (item.runtime_keys && item.runtime_keys.length > 0) return item.runtime_keys;
  const key = runtimeKeyOf(item);
  return key ? [key] : [];
}

/** 引擎展示名：Rust 下发的 engine 优先，缺失回退 runtime_key/format 原值（不做格式→引擎推导） */
export function engineOf(
  item: Pick<ModelItemState, "engine" | "runtime_key" | "format"> | undefined | null,
): string | null {
  if (!item) return null;
  return item.engine || runtimeKeyOf(item);
}

/** 依据模型清单元数据判断模型种类；清单未就绪时默认 ASR（事件路径应优先采信 payload.kind） */
export function resolveModelKind(name: string): ModelKind | null {
  if (!name) return null;
  const item = useAppStore.getState().models.items.find((i) => i.name === name);
  if (item) return item.kind;
  // 无清单可查时不猜名字：默认 ASR（与旧默认语义一致）
  return "asr";
}

/** 统一的「是否已加载」判定：engines[kind].status === "ready" 且 model 匹配 */
export function computeIsLoaded(kind: ModelKind, name: string): boolean {
  const eng = useAppStore.getState().engines[kind];
  return eng.status === "ready" && eng.model === name;
}

/** 将引擎状态应用到 engines（替代旧的 applyModelStatus 写 ttsModelStatus/asr.modelStatus） */
export function applyEngineStatus(
  kind: ModelKind | null,
  status: "idle" | "loading" | "ready" | "error",
  error?: string | null,
): void {
  if (!kind) return;
  const s = useAppStore.getState();
  // ready / error / idle 时清掉加载阶段（stage 只在 loading 期间有意义）
  const stage = status === "loading" ? s.engines[kind].stage : null;
  s.setEngineStatus(kind, { status, stage, error: error ?? null });
  // 状态域同步：ASR/TTS 面板徽章仍读 asr.modelStatus / ttsModelStatus，
  // 若只写 engines，失败时徽章会永远停在 loading（用户看不到失败原因）。
  if (status !== "loading") {
    if (kind === "asr") s.updateAsr({ modelStatus: status });
    else s.setTtsModelStatus(status);
  }
}

/**
 * 依据 Rust 下发的权威框架对齐 ASR 标签：
 * - runtimeKey（运行时包 key）→ asr.framework（模型页过滤 / 持久化域）
 * - engine（引擎展示名）→ engines.asr.framework（展示域）
 * 事件的 framework 是 Rust 框架 id（可能是运行时包 key，也可能是引擎注册键），
 * 统一用模型清单数据归一，不再做 format → engine 的白名单/二分映射。
 * engine / modelName 由事件或清单下发，均可缺省。
 */
export function applyAsrFrameworkFromRust(
  fw: string,
  engine?: string | null,
  modelName?: string | null,
): void {
  if (!fw) return;
  const s = useAppStore.getState();
  const item =
    (modelName ? s.models.items.find((i) => i.name === modelName) : undefined) ??
    s.models.items.find((i) => i.engine === fw) ??
    s.models.items.find((i) => runtimeKeyOf(i) === fw);
  // 归一到运行时包 key：模型数据优先；该 id 本身就是已登记的运行时包时原样使用
  const key =
    (item ? runtimeKeyOf(item) : null) ??
    (s.runtime.packages?.some((p) => p.framework === fw) ? fw : null);
  const eng = engine || item?.engine || (fw !== key ? fw : null);
  if (key && s.asr.framework !== key) s.updateAsr({ framework: key });
  if (eng && s.engines.asr.framework !== eng) s.setEngineStatus("asr", { framework: eng });
}

/** 依据「已加载/正在加载」的模型 + 清单元数据对齐框架标签（清单晚到时的兜底） */
export function syncAsrFrameworkFromLoaded(): void {
  const s = useAppStore.getState();
  const name = s.engines.asr.model || s.asr.model;
  if (!name) return;
  const item = s.models.items.find((i) => i.name === name);
  if (!item) return;
  const key = runtimeKeyOf(item);
  if (!key) return;
  applyAsrFrameworkFromRust(key, item.engine, name);
}

/**
 * TTS 版框架对齐（与 ASR 同源，字段域不同）：
 * - 运行时包 key → `tts.framework`（模型页过滤 / 持久化域）
 * - 引擎展示名 → `engines.tts.framework`（展示域）
 *
 * 事件的 framework 是 Rust 注册表的框架 id（`sherpa` / `pytorch`），而归一化目标是
 * 模型清单里的**主运行时包 key**（`onnx` / `pytorch-cpu`）——这正是下拉框选项的来源，
 * 两边必须同一套取值，否则选中值对不上选项、下拉框会显示空白或凭空多一项。
 * cuda 设备实际用的是 `pytorch-cuda130` 包，但过滤按 runtime_keys 成员判定（见 ModelSelector），
 * 所以框架标签仍归一到主 key，不随设备抖动。
 */
export function applyTtsFrameworkFromRust(
  fw: string,
  engine?: string | null,
  modelName?: string | null,
): void {
  if (!fw) return;
  const s = useAppStore.getState();
  const item =
    (modelName ? s.models.items.find((i) => i.name === modelName) : undefined) ??
    s.models.items.find((i) => i.kind === "tts" && (i.engine === fw || runtimeKeyOf(i) === fw));
  const key =
    (item ? runtimeKeyOf(item) : null) ??
    (s.runtime.packages?.some((p) => p.framework === fw) ? fw : null);
  const eng = engine || item?.engine || (fw !== key ? fw : null);
  if (key && s.tts.framework !== key) s.updateTts({ framework: key });
  if (eng && s.engines.tts.framework !== eng) s.setEngineStatus("tts", { framework: eng });
}

/** 依据「已加载/正在加载」的 TTS 模型 + 清单元数据对齐框架标签（清单晚到时的兜底） */
export function syncTtsFrameworkFromLoaded(): void {
  const s = useAppStore.getState();
  const name = s.engines.tts.model || s.tts.model;
  if (!name) return;
  const item = s.models.items.find((i) => i.name === name);
  if (!item) return;
  const key = runtimeKeyOf(item);
  if (!key) return;
  applyTtsFrameworkFromRust(key, item.engine, name);
}

/**
 * 框架下拉选项：按模型清单推导（去重，顺序 = 清单顺序），并**把 `onnx` 固定排到最后**。
 *
 * 为什么 onnx 垫底：它是历史默认运行时，此前只有它一个；接入 PyTorch 后下拉顶部若仍是
 * onnx，看起来像"新框架没进来"。固定垫底后，新框架自然浮到前面，且与清单顺序无关。
 * 其余框架保持清单顺序（清单顺序 = 优先级，由 Rust 的 SPECS 决定）。
 *
 * `current`（当前选中值）不在清单里时（清单未到 / 模型已下架）补到最前面，避免选择框空白。
 */
const LAST_FRAMEWORK_KEYS = ["onnx"];

export function frameworkOptionsOf(
  items: Pick<ModelItemState, "kind" | "runtime_key" | "runtime_keys" | "format">[],
  kind: "asr" | "tts",
  packages: { framework: string; name: string }[] | null | undefined,
  current: string,
): { key: string; label: string }[] {
  const seen = new Set<string>();
  const derived: { key: string; label: string }[] = [];
  for (const m of items) {
    if (m.kind !== kind) continue;
    const key = runtimeKeyOf(m);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    derived.push({ key, label: packages?.find((p) => p.framework === key)?.name ?? key });
  }
  // 垫底项从 derived 里摘出来接到末尾（不是 sort：其余项的相对顺序必须保持清单顺序）
  const head = derived.filter((o) => !LAST_FRAMEWORK_KEYS.includes(o.key));
  const tail = LAST_FRAMEWORK_KEYS.map((k) => derived.find((o) => o.key === k)).filter(
    (o): o is { key: string; label: string } => Boolean(o),
  );
  const out = [...head, ...tail];
  if (current && !seen.has(current)) {
    const pkg = packages?.find((p) => p.framework === current);
    out.unshift({ key: current, label: pkg?.name ?? current });
  }
  return out;
}

/**
 * 运行时包的展示名（多处共用：全局横幅 / 模型卡片 / 门禁提示）。
 *
 * 同一个引擎可能有多个包（PyTorch 的 cpu / cuda130），它们的 `name` **都是 "PyTorch"** ——
 * 直接 `map(p => p.name).join(" / ")` 会渲染成 "PyTorch / PyTorch"，用户看到的就是
 * "为什么 PyTorch 变成两个包"。所以重名时才补变体：`PyTorch (cpu)` / `PyTorch (cuda130)`；
 * 不重名则保持原名（llama-server、sherpa-onnx 不受影响）。
 */
export function runtimePackageLabels(
  pkgs: { name: string; variant?: string | null }[],
): string[] {
  const dup = new Set(
    pkgs.map((p) => p.name).filter((n, i, all) => all.indexOf(n) !== i),
  );
  return pkgs.map((p) => (dup.has(p.name) && p.variant ? `${p.name} (${p.variant})` : p.name));
}

/**
 * 「当前」行里框架的展示名：取运行时包名（与框架下拉、框架页一致），取不到再回退引擎注册键。
 *
 * 为什么这行要带框架：模型名不保证全局唯一 —— 同一个名字在 llama 与 pytorch 下都可能有，
 * 而两个引擎互斥、只会有一个在跑，不带框架就看不出"现在起作用的是哪一个"。
 */
export function loadedFrameworkLabel(kind: ModelKind): string {
  const s = useAppStore.getState();
  const e = s.engines[kind];
  if (!e.model) return "";
  const item = s.models.items.find((i) => i.name === e.model);
  const key = runtimeKeyOf(item) ?? e.framework;
  return s.runtime.packages?.find((p) => p.framework === key)?.name ?? e.framework ?? "";
}

/** 某模型是否属于该运行时包（cuda 变体共用同一引擎：按 runtime_keys 成员判定） */
export function belongsToFramework(
  item: Pick<ModelItemState, "runtime_keys" | "runtime_key" | "format"> | undefined | null,
  framework: string,
): boolean {
  return Boolean(framework) && runtimeKeysOf(item).includes(framework);
}

/**
 * 任一引擎加载中 → 返回是哪一类（React selector）。
 *
 * 加载中必须禁用所有"会发起加载"的入口（模型卡片、框架/设备下拉）：`modelLoader` 里的
 * 全局门禁会拦下这些请求，但拦下来时用户已经点完了 —— 表现为"点了没反应"。
 * 门禁与禁用必须成对，且共用这一个判定。
 */
export function selectLoadingKind(s: {
  engines: { asr?: { status?: string } | null; tts?: { status?: string } | null };
}): "asr" | "tts" | null {
  if (s.engines?.asr?.status === "loading") return "asr";
  if (s.engines?.tts?.status === "loading") return "tts";
  return null;
}
