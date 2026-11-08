/**
 * ASR 输出文本的清洗（框架无关）。
 *
 * Qwen3-ASR 的原始输出形如 `language Chinese<asr_text>今天下午三点开会。`，
 * 其中 `language <语种>` 是模型自述的检测语种，`<asr_text>` 才是正文。
 */

/**
 * 从模型原始输出中提取纯文本。
 *
 * 输入示例：`"language Chinese<asr_text>今天下午三点开会。"` 或 `"今天下午三点开会。"`
 */
export function extractAsrText(raw: string): string {
  const start = raw.indexOf('<asr_text>')
  if (start >= 0) {
    const after = raw.slice(start + '<asr_text>'.length)
    // 截到下一个 '<' 或字符串末尾
    const end = after.indexOf('<')
    if (end >= 0) return after.slice(0, end).trim()
    return after.trim()
  }
  // 去掉 "language Chinese" 前缀
  const pos = raw.indexOf('language ')
  if (pos >= 0) {
    // 找第一个 "Chinese" 或 "English" 之后（即第一个非 ASCII 字母处）
    const rest = raw.slice(pos + 9)
    const m = rest.match(/[^A-Za-z]/)
    if (m && m.index !== undefined) {
      return raw.slice(pos + 9 + m.index).trim()
    }
  }
  return raw.trim()
}
