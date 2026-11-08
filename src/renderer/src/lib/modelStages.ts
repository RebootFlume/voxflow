/**
 * 引擎加载阶段（框架无关）—— 启动遮罩与全局加载遮罩共用同一套阶段 / 进度 / 文案。
 *
 * 阶段由主进程 onStage 上报（llama.cpp FFI / sherpa-ffi / registry）：
 *   unload → loading → initializing → ready
 * `unload:<模型名>` 是带模型名的卸载变体，归到 unload。
 *
 * 为什么要抽出来：两处遮罩各写一份映射，启动页那份漏了 "ready" ——
 * 于是最后阶段文案从「正在初始化推理引擎…」倒退成「正在加载模型文件…」。
 */

const STAGE_PROGRESS: Record<string, number> = {
  unload: 15,
  loading: 45,
  initializing: 80,
  ready: 100,
};

const STAGE_LABEL_KEY: Record<string, string> = {
  unload: "overlay.stage.unload",
  loading: "overlay.stage.loading",
  initializing: "overlay.stage.initializing",
  ready: "overlay.stage.ready",
};

/** 归一化：`unload:xxx` → `unload`；空 → 空 */
function normStage(stage?: string | null): string {
  const s = stage ?? "";
  return s.startsWith("unload") ? "unload" : s;
}

/** 阶段 → 进度百分比（未知阶段按 loading 计） */
export function stageProgress(stage?: string | null): number {
  return STAGE_PROGRESS[normStage(stage)] ?? STAGE_PROGRESS.loading;
}

/** 阶段 → i18n 文案键（未知阶段按 loading 计） */
export function stageLabelKey(stage?: string | null): string {
  return STAGE_LABEL_KEY[normStage(stage)] ?? STAGE_LABEL_KEY.loading;
}
