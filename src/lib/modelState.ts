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
import { useAppStore } from "@/stores";

export type ModelKind = "asr" | "tts";

/** 依据模型清单元数据判断模型种类；清单未就绪时按名称兜底（避免事件被吞） */
export function resolveModelKind(name: string): ModelKind | null {
  if (!name) return null;
  const item = useAppStore.getState().models.items.find((i) => i.name === name);
  if (item) return item.kind;
  // 兜底：清单未加载时按名称推断（E2E TTS 模型名特征，其余默认 ASR）
  const lower = name.toLowerCase();
  if (/kokoro|matcha|zipvoice|pocket|supertonic|kitten/.test(lower)) return "tts";
  return "asr";
}

/** 统一的「是否已加载」判定：engines[kind].status === "ready" 且 model 匹配 */
export function computeIsLoaded(kind: ModelKind, name: string): boolean {
  const eng = useAppStore.getState().engines[kind];
  return eng.status === "ready" && eng.model === name;
}

/** 引擎加载状态（直接读 engines） */
export function getEngineStatus(kind: ModelKind): "idle" | "loading" | "ready" | "error" {
  return useAppStore.getState().engines[kind].status;
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
}
