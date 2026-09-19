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
