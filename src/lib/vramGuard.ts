/**
 * 显存预检弹框的「本会话记忆」。
 *
 * 语义：用户在弹框里已经明确选择过「仍用 GPU 试」的 model|device，
 * 本会话内不再重复打扰（刷新页面即失效，不落盘、不引入任何状态库）。
 */

/** 已确认「仍用 GPU 试」的 `model|device` 键集合（仅内存，刷新即失效） */
const confirmed = new Set<string>();

/** 本会话是否已确认过「仍用 GPU 试」 */
export function alreadyConfirmedRemembered(model: string, device: string): boolean {
  return confirmed.has(`${model}|${device}`);
}

/** 记住用户选择「仍用 GPU 试」（本会话后续同 model|device 不再弹框） */
export function rememberConfirmed(model: string, device: string): void {
  confirmed.add(`${model}|${device}`);
}
