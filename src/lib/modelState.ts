/**
 * 模型状态「判定」与「应用」的收敛层。
 *
 * 原来「这是 ASR 还是 TTS 模型」靠 `model !== store.tts.model` 这种脆弱对比猜测，
 * 现在统一依据 models.items[].kind（模型自身的类型元数据）判断；
 * 「哪个模型已加载」的公式也从 ModelRow / ModelSelector 两处重复收敛到这里。
 */
import { useAppStore } from "@/stores/app";

export type ModelKind = "asr" | "tts";

/** 依据模型清单元数据判断模型种类（不再用名称对比猜测） */
export function resolveModelKind(name: string): ModelKind | null {
  if (!name) return null;
  const item = useAppStore.getState().models.items.find((i) => i.name === name);
  return item ? item.kind : null;
}

/** 统一的「是否已加载」判定（ModelRow 与 ModelSelector 共用同一份公式） */
export function computeIsLoaded(
  kind: ModelKind,
  name: string,
  ctx: { ttsModel: string; loadedModel: string | null; asrModel: string },
): boolean {
  if (kind === "tts") return ctx.ttsModel === name;
  return ctx.loadedModel === name || ctx.asrModel === name;
}

/** 将某个模型状态应用到对应模块（ASR / TTS 各自的状态字段，统一入口） */
export function applyModelStatus(
  kind: ModelKind | null,
  status: "idle" | "loading" | "ready" | "error",
): void {
  if (!kind) return;
  const s = useAppStore.getState();
  if (kind === "tts") s.setTtsModelStatus(status);
  else if (kind === "asr") s.updateAsr({ modelStatus: status });
}
