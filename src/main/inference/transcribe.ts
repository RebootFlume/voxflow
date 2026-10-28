/**
 * 长音频分批转写编排（框架无关，任何 AsrEngine 都受益）
 * —— 对齐 Rust 版 `src-tauri/src/inference/transcribe_chunks.rs`。
 *
 * ## 算法（参照 CapsWriter 滑动窗口）
 * 段长 60s + 重叠 8s：
 *   - 每段实际发送 68s（60s 正片 + 8s 重叠尾巴）
 *   - 窗口每次前移 60s，相邻段有 8s 重叠，防止句子被切碎
 *   - 剩余不足 68s 的残留作为最后一段
 *
 * ## 接缝处理（两道，缺一不可）
 *  1. **跨段记忆**：每段把「已累积文本尾部 CTX_CHARS 字」作为上文随音频送模型
 *  2. **重叠去重**：同一段重叠音频被识别两次，`mergeByText` 按文本对齐削掉重复
 */

import type { AsrEngine } from './engine'

/** 段长（秒）：CapsWriter 同款。68s 段 ≈ 1.2k token，配 2048 ctx 有近 1.7× 余量 */
export const SEG_DURATION_SEC = 60
/** 重叠（秒）：防止句子被段边界切断 */
export const SEG_OVERLAP_SEC = 8
/** 单段最大长度超过此值才需要分段（短音频直接单次转写，零开销） */
export const CHUNK_THRESHOLD_SEC = SEG_DURATION_SEC
/** 跨段记忆的上文字数（≈120 token） */
export const CTX_CHARS = 120

/** 重叠匹配窗口：上一段尾 / 新段头各取多少字参与对齐 */
const OVERLAP_WINDOW = 100
/** 重叠匹配的最短长度：4s 重叠 ≈ 12–17 字，取 6 可避免把「用户真的重复说」误删 */
const OVERLAP_MIN_MATCH = 6
/** 合并对齐时忽略的标点（与 CapsWriter 同集合），避免标点差异干扰匹配 */
const PUNCT = '，。！？；：、「」『』（）《》【】[]{},.!?;:"\''

/** 进度回调：每段完成后触发（doneSec: 已转写秒数, totalSec: 总秒数） */
export type ProgressFn = (doneSec: number, totalSec: number) => void

/**
 * 分批转写长音频。返回完整拼接文本。
 * 音频 ≤60s 直接单次转写（无分段开销）。
 */
export async function transcribeLong(
  engine: AsrEngine,
  samples: Float32Array,
  sampleRate: number,
  onProgress: ProgressFn
): Promise<string> {
  const totalSec = samples.length / sampleRate

  // 短音频：单次转写，免分段
  if (samples.length <= SEG_DURATION_SEC * sampleRate) {
    const text = await engine.transcribe(samples, sampleRate)
    onProgress(totalSec, totalSec)
    return text
  }

  const segLen = SEG_DURATION_SEC * sampleRate
  const overlapLen = SEG_OVERLAP_SEC * sampleRate
  const chunkLen = segLen + overlapLen
  const stride = segLen

  // 累积合并（而非 join）：每段都带着「上文」转写，再按重叠文本对齐去重拼进来
  let merged = ''
  let offset = 0

  // 滑动窗口切段
  while (offset + chunkLen <= samples.length) {
    const seg = samples.subarray(offset, offset + chunkLen)
    const text = await transcribeSeg(engine, seg, sampleRate, merged)
    if (text.length > 0) merged = mergeByText(merged, text)
    offset += stride
    onProgress(Math.min(offset / sampleRate, totalSec), totalSec)
  }

  // 剩余不足一段 → 作为最后一段
  if (offset < samples.length) {
    const seg = samples.subarray(offset)
    const text = await transcribeSeg(engine, seg, sampleRate, merged)
    if (text.length > 0) merged = mergeByText(merged, text)
    onProgress(totalSec, totalSec)
  }

  const result = merged.trim()
  if (result.length === 0) {
    throw new Error('分批转写结果为空（音频可能无有效语音）')
  }
  return result
}

/**
 * 单段转写：把「已累积文本的尾部」作为上文送模型（跨段记忆）。
 * 首段无上文 → 走无上下文路径。
 */
async function transcribeSeg(
  engine: AsrEngine,
  seg: Float32Array,
  sampleRate: number,
  merged: string
): Promise<string> {
  const ctx = ctxTail(merged, CTX_CHARS)
  const text = ctx.length === 0 ? await engine.transcribe(seg, sampleRate) : await engine.transcribeWithContext(seg, sampleRate, ctx)
  return text.trim()
}

/** 取文本尾部 `n` 字作为跨段上文（不足则全取；trim 后返回） */
export function ctxTail(text: string, n: number): string {
  const chars = [...text]
  if (chars.length <= n) return text.trim()
  return chars.slice(chars.length - n).join('').trim()
}

/**
 * 重叠文本去重合并（CapsWriter `text_merger.merge_by_text` 同款思路）。
 *
 * 在 `prev` 尾部与 `new` 头部找最佳对齐块（块终点须落在 prev 后 1/4、块起点须落在 new 前 1/4，
 * 评分 `len² + 位置`），保留 prev 到块终点、接上 new 块终点之后的内容。
 * 找不到合格重叠 → 直接拼接（安全回退，绝不丢字）。
 */
export function mergeByText(prev: string, next: string): string {
  if (prev.length === 0) return next
  if (next.length === 0) return prev

  // 1. 去两端标点：同一段音频两次识别可能只在标点上不同，不该因此对不上
  const prevClean = [...prev.replace(/[，。！？；：、「」『』（）《》【】[\]{},.!?;:"']+$/u, '')]
  const newChars = [...next]
  const newStart = newChars.findIndex((c) => !PUNCT.includes(c))
  const newClean = newStart < 0 ? [] : newChars.slice(newStart)

  if (prevClean.length === 0 || newClean.length === 0) return prev + next

  // 2. 尾/头窗口对齐
  const tailStart = Math.max(0, prevClean.length - OVERLAP_WINDOW)
  const tail = prevClean.slice(tailStart)
  const head = newClean.slice(0, Math.min(newClean.length, OVERLAP_WINDOW))

  const overlap = bestOverlap(tail, head)
  if (!overlap) return prev + next
  const [a, b, len] = overlap

  // 3. prev 保留到匹配终点，new 从匹配终点之后续接（重叠段只保留一份）
  const keep = tailStart + a + len
  return prevClean.slice(0, keep).join('') + newClean.slice(b + len).join('')
}

/**
 * 尾/头窗口中的最佳对齐块：最长公共子串 + 位置约束（评分同 CapsWriter 的 `len² + a - b`）。
 */
function bestOverlap(tail: string[], head: string[]): [number, number, number] | null {
  const tl = tail.length
  const hl = head.length
  if (tl < OVERLAP_MIN_MATCH || hl < OVERLAP_MIN_MATCH) return null

  const tailEndThreshold = Math.floor(tl / 4) * 3 // 匹配终点须落在 tail 后 1/4
  const headStartThreshold = Math.floor(hl / 4) // 匹配起点须落在 head 前 1/4

  let prevRow = new Uint16Array(hl + 1)
  let curRow = new Uint16Array(hl + 1)
  let best: [number, number, number] | null = null
  let bestScore = Number.NEGATIVE_INFINITY

  for (let i = 1; i <= tl; i++) {
    curRow[0] = 0
    for (let j = 1; j <= hl; j++) {
      curRow[j] = tail[i - 1] === head[j - 1] ? prevRow[j - 1] + 1 : 0
      const len = curRow[j]
      if (len >= OVERLAP_MIN_MATCH) {
        const a = i - len
        const b = j - len
        if (a + len > tailEndThreshold && b <= headStartThreshold) {
          const score = len * len + a - b
          if (score > bestScore) {
            bestScore = score
            best = [a, b, len]
          }
        }
      }
    }
    const tmp = prevRow
    prevRow = curRow
    curRow = tmp
  }

  return best
}
