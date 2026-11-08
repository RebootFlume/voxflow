/**
 * 「最近一次被请求的 ASR 模型」记账（框架无关）。
 *
 * 用途：热键 / 文件转写 / 对外 API 这些兜底入口，需要知道用户当前想用哪个模型。
 * 它描述的是**用户意图**，不属于任何具体引擎实现 —— 所以单独成模块，
 * 换引擎（子进程 / 进程内 FFI）时这段逻辑原样复用。
 */

let lastRequested: { name: string; device: string } | null = null

/** 最近一次被请求的模型（没有则 null） */
export function lastRequestedModel(): { name: string; device: string } | null {
  return lastRequested
}

/** 记录一次成功的加载请求 */
export function recordLastRequested(name: string, device: string): void {
  lastRequested = { name, device }
}
