/**
 * 长文本切分（TTS 分段合成的第一步）
 *
 * 位置说明：这份逻辑同时被**主进程**（真正切分后逐段合成）与**渲染进程**（导入 TXT 后
 * 预估「会切成几段、大约多少分钟」）使用，所以放在 `src/shared/`。
 * 若前端自己另写一份估算，段数迟早与后端不一致 —— 用户看到"84 段"、实际跑 92 段。
 * —— 对齐 Rust 版 `src-tauri/src/tts/chunk.rs`。
 *
 * 与 ASR 侧的 `inference/transcribe.ts` 同构：短文本不分段，超过阈值才切。
 * 切点一律落在标点之后，尽量不破坏韵律：
 *  1. 优先句末标点（`。！？；!?;\n`）
 *  2. 退而求其次：句内标点（`，、：, ）`与空格）
 *  3. 都没有（超长英文串 / URL / 无标点长句）⇒ 按字符硬切
 *
 * 段大小同时决定两件事：**取消的生效延迟**与**进度粒度**（段内不可中断）。
 */

/**
 * 每段目标字符数。CPU 上 RTF≈1.5，120 字约 25~30s 音频 ⇒ 单段约 40s，
 * 这也是「点了取消之后最多还要等多久」的上限。
 */
export const MAX_CHARS_PER_CHUNK = 120

/** 句末标点：切在这里最不伤韵律 */
const HARD_BREAKS = ['。', '！', '？', '；', '!', '?', ';', '\n', '\r']
/** 句内标点：没有句末标点时的退路 */
const SOFT_BREAKS = ['，', '、', '：', ',', ':', '）', ')']

/** 允许切出的最小段长，避免「嗯。」这种极短段（碎段会明显伤韵律） */
function minCut(maxChars: number): number {
  return Math.max(Math.floor(maxChars / 3), 1)
}

/**
 * 在 `limit` 个字符之内，找 `set` 里最后一个断点**之后**的字符位置。
 * 断点位置不足 `minCut` 则不采用（宁可继续往下找或硬切）。
 */
function lastBreakBefore(text: string, limit: number, set: string[]): number | null {
  const floor = minCut(limit)
  const chars = [...text]
  let best: number | null = null
  for (let count = 0; count < chars.length && count < limit; count++) {
    if (set.includes(chars[count]) && count + 1 >= floor) {
      best = count + 1
    }
  }
  return best
}

/**
 * 按标点切分长文本。
 *
 * - 文本（去首尾空白后）不超过 `maxChars` ⇒ 返回单段，调用方据此走「不分段」路径。
 * - 切分只吃掉段间的空白字符，其余字符一个不丢。
 */
export function splitText(text: string, maxChars: number): string[] {
  const limit = Math.max(maxChars, 1)
  const out: string[] = []
  let rest = text.trim()

  while (rest.length > 0) {
    if ([...rest].length <= limit) {
      out.push(rest.trim())
      break
    }
    const cut =
      lastBreakBefore(rest, limit, HARD_BREAKS) ??
      lastBreakBefore(rest, limit, SOFT_BREAKS) ??
      limit
    const chars = [...rest]
    out.push(chars.slice(0, cut).join('').trim())
    rest = chars.slice(cut).join('').trimStart()
  }

  return out.filter((s) => s.length > 0)
}
