//! 长音频分批转写编排（框架无关，任何 AsrEngine 都受益）
//!
//! ## 为什么需要
//! llama-server 的 context 有限（2048 token），一次性发送长音频会 400 错误。
//! sherpa-onnx 虽支持流式任意长度，但为统一各框架能力，长音频一律走本模块分段。
//!
//! ## 算法（参照 CapsWriter 滑动窗口）
//! 段长 60s + 重叠 4s：
//!   - 每段实际发送 64s（60s 正片 + 4s 重叠尾巴）
//!   - 窗口每次前移 60s，相邻段有 4s 重叠，防止句子被切碎
//!   - 剩余不足 64s 的残留作为最后一段
//!   - 64s 实测 ≈ 850 audio token + 输出 ≈ 1.1k < 2048 ctx ✅（单段安全，近 2× 余量）
//!
//! ## 接缝处理（两道，缺一不可）
//! 硬切不可避免会把句子切成两半，两道处理都在本模块：
//!   1. **跨段记忆**：每段把「已累积文本尾部 CTX_CHARS 字」作为上文随音频送模型
//!      （`AsrEngine::transcribe_with_context`）。实测（0.6B，130s 实录在 60s 处硬切）：
//!      无上文把「沉淀」认成「纯电」；给出**截断到接缝前**的上文（模型无从照抄）仍认对
//!      ⇒ 真实识别受益，非复制。
//!   2. **重叠去重**：同一段重叠音频被识别两次，`merge_by_text` 按文本对齐削掉重复。
//!      ⚠️ 记忆会让模型偶尔复述上文尾部，去重同时负责削掉这种复述 ⇒ 两者必须成对启用。
//!
//! ## 框架无关
//! 只依赖 `AsrEngine::transcribe` / `transcribe_with_context`，llama-server / sherpa / PyTorch
//! 未来接入零成本获得长音频能力（无上下文能力的引擎走 trait 默认实现，行为不变）。
//! 引擎永远只处理 ≤64s 的一段。

use super::engine::AsrEngine;

/// 段长（秒）：CapsWriter 同款。实测音频 token 率 13.2/s（60s → 808 input tokens），
/// 故 64s 段 ≈ 1.1k token，配 2048 ctx 有近 2× 余量（旧注释「60s≈6000 token」高估 7 倍）
pub const SEG_DURATION_SEC: usize = 60;
/// 重叠（秒）：防止句子被段边界切断
pub const SEG_OVERLAP_SEC: usize = 4;

/// 单段最大长度超过此值才需要分段（短音频直接单次转写，零开销）
pub const CHUNK_THRESHOLD_SEC: usize = SEG_DURATION_SEC;

/// 跨段记忆的上文字数（≈120 token；64s 音频 ≈ 860 token，合计仍远低于 ctx 2048）
pub const CTX_CHARS: usize = 120;

/// 重叠匹配窗口：上一段尾 / 新段头各取多少字参与对齐
const OVERLAP_WINDOW: usize = 100;

/// 重叠匹配的最短长度：4s 重叠 ≈ 12–17 字，取 6 可避免把「用户真的重复说」误删
/// （CapsWriter 用 2，偏激进）
const OVERLAP_MIN_MATCH: usize = 6;

/// 合并对齐时忽略的标点（与 CapsWriter 同集合），避免标点差异干扰匹配
const PUNCT: &str = "，。！？；：、「」『』（）《》【】[]{},.!?;:\"'";

/// 进度回调：每段完成后触发（done_sec: 已转写秒数, total_sec: 总秒数）
pub type ProgressFn<'a> = &'a mut dyn FnMut(f64, f64);

/// 分批转写长音频
///
/// 返回完整拼接文本。音频 ≤60s 直接单次转写（无分段开销）。
pub fn transcribe_long(
    engine: &dyn AsrEngine,
    samples: &[f32],
    sample_rate: u32,
    on_progress: ProgressFn,
) -> Result<String, String> {
    let total_sec = samples.len() as f64 / sample_rate as f64;

    // 短音频：单次转写，免分段
    if samples.len() <= SEG_DURATION_SEC * sample_rate as usize {
        let text = engine.transcribe(samples, sample_rate)?;
        on_progress(total_sec, total_sec);
        return Ok(text);
    }

    let seg_len = SEG_DURATION_SEC * sample_rate as usize;   // 段长（样本数）
    let overlap_len = SEG_OVERLAP_SEC * sample_rate as usize; // 重叠（样本数）
    let chunk_len = seg_len + overlap_len;                     // 每段实际发送长度
    let stride = seg_len;                                      // 窗口前进步长

    // 累积合并（而非 join）：每段都带着「上文」转写，再按重叠文本对齐去重拼进来
    let mut merged = String::new();
    let mut offset = 0usize;

    // 滑动窗口切段
    while offset + chunk_len <= samples.len() {
        let seg = &samples[offset..offset + chunk_len];
        let text = transcribe_seg(engine, seg, sample_rate, &merged)?;
        if !text.is_empty() {
            merged = merge_by_text(&merged, &text);
        }
        offset += stride;
        let done_sec = (offset as f64 / sample_rate as f64).min(total_sec);
        on_progress(done_sec, total_sec);
    }

    // 剩余不足一段 → 作为最后一段（CapsWriter 的 is_final）
    if offset < samples.len() {
        let seg = &samples[offset..];
        let text = transcribe_seg(engine, seg, sample_rate, &merged)?;
        if !text.is_empty() {
            merged = merge_by_text(&merged, &text);
        }
        on_progress(total_sec, total_sec);
    }

    let merged = merged.trim().to_string();
    if merged.is_empty() {
        return Err("分批转写结果为空（音频可能无有效语音）".into());
    }

    Ok(merged)
}

/// 单段转写：把「已累积文本的尾部」作为上文送模型（跨段记忆）。
/// 首段无上文 → 走无上下文路径（引擎 trait 默认实现，行为与改动前一致）。
fn transcribe_seg(
    engine: &dyn AsrEngine,
    seg: &[f32],
    sample_rate: u32,
    merged: &str,
) -> Result<String, String> {
    let ctx = ctx_tail(merged, CTX_CHARS);
    let text = if ctx.is_empty() {
        engine.transcribe(seg, sample_rate)?
    } else {
        engine.transcribe_with_context(seg, sample_rate, &ctx)?
    };
    Ok(text.trim().to_string())
}

/// 取文本尾部 `n` 字作为跨段上文（不足则全取；trim 后返回）
pub fn ctx_tail(text: &str, n: usize) -> String {
    let total = text.chars().count();
    if total <= n {
        return text.trim().to_string();
    }
    text.chars().skip(total - n).collect::<String>().trim().to_string()
}

/// 重叠文本去重合并（CapsWriter `text_merger.merge_by_text` 同款思路）。
///
/// 在 `prev` 尾部与 `new` 头部找最佳对齐块（块终点须落在 prev 后 1/4、块起点须落在 new 前 1/4，
/// 评分 `len² + 位置`），保留 prev 到块终点、接上 new 块终点之后的内容。
/// 找不到合格重叠 → 直接拼接（安全回退，绝不丢字）。
pub fn merge_by_text(prev: &str, new: &str) -> String {
    if prev.is_empty() {
        return new.to_string();
    }
    if new.is_empty() {
        return prev.to_string();
    }
    // 1. 去两端标点：同一段音频两次识别可能只在标点上不同，不该因此对不上
    let prev_clean: Vec<char> = prev.trim_end_matches(|c| PUNCT.contains(c)).chars().collect();
    let new_chars: Vec<char> = new.chars().collect();
    let new_start = new_chars
        .iter()
        .position(|c| !PUNCT.contains(*c))
        .unwrap_or(new_chars.len());
    let new_clean = &new_chars[new_start..];
    if prev_clean.is_empty() || new_clean.is_empty() {
        return format!("{prev}{new}");
    }
    // 2. 尾/头窗口对齐
    let tail_start = prev_clean.len().saturating_sub(OVERLAP_WINDOW);
    let tail = &prev_clean[tail_start..];
    let head = &new_clean[..new_clean.len().min(OVERLAP_WINDOW)];
    let Some((a, b, len)) = best_overlap(tail, head) else {
        return format!("{prev}{new}");
    };
    // 3. prev 保留到匹配终点，new 从匹配终点之后续接（重叠段只保留一份）
    let keep = tail_start + a + len;
    let mut out: String = prev_clean[..keep].iter().collect();
    out.extend(new_clean[b + len..].iter());
    out
}

/// 尾/头窗口中的最佳对齐块：最长公共子串 + 位置约束（评分同 CapsWriter 的 `len² + a - b`）。
///
/// 与 CapsWriter 的差异：他们用 `difflib.SequenceMatcher.get_matching_blocks()`（多块、允许块间差异），
/// 但其评分由 `len²` 主导 ⇒ 取「最长公共块」等价；本实现无外部依赖、无额外分配（≤100×100 DP）。
fn best_overlap(tail: &[char], head: &[char]) -> Option<(usize, usize, usize)> {
    let (tl, hl) = (tail.len(), head.len());
    if tl < OVERLAP_MIN_MATCH || hl < OVERLAP_MIN_MATCH {
        return None;
    }
    let tail_end_threshold = tl / 4 * 3; // 匹配终点须落在 tail 后 1/4
    let head_start_threshold = hl / 4; // 匹配起点须落在 head 前 1/4
    let mut prev_row = vec![0u16; hl + 1];
    let mut cur_row = vec![0u16; hl + 1];
    let mut best: Option<(usize, usize, usize)> = None;
    let mut best_score: i64 = i64::MIN;
    for i in 1..=tl {
        cur_row[0] = 0;
        for j in 1..=hl {
            cur_row[j] = if tail[i - 1] == head[j - 1] {
                prev_row[j - 1] + 1
            } else {
                0
            };
            let len = cur_row[j] as usize;
            if len >= OVERLAP_MIN_MATCH {
                let (a, b) = (i - len, j - len);
                if a + len > tail_end_threshold && b <= head_start_threshold {
                    let score = (len * len) as i64 + a as i64 - b as i64;
                    if score > best_score {
                        best_score = score;
                        best = Some((a, b, len));
                    }
                }
            }
        }
        std::mem::swap(&mut prev_row, &mut cur_row);
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用假引擎：记录每次收到的样本长度，返回固定文本
    struct FakeEngine {
        received: std::sync::Mutex<Vec<usize>>,
        /// 每次调用收到的上文（无上文记空串）
        ctxs: std::sync::Mutex<Vec<String>>,
        total_calls: std::sync::atomic::AtomicUsize,
    }

    impl FakeEngine {
        fn new() -> Self {
            Self {
                received: std::sync::Mutex::new(Vec::new()),
                ctxs: std::sync::Mutex::new(Vec::new()),
                total_calls: std::sync::atomic::AtomicUsize::new(0),
            }
        }
        fn calls(&self) -> usize {
            self.total_calls.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn ctxs(&self) -> Vec<String> {
            self.ctxs.lock().unwrap().clone()
        }
        fn record(&self, samples: &[f32], ctx: &str) -> Result<String, String> {
            let n = self.total_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            self.received.lock().unwrap().push(samples.len());
            self.ctxs.lock().unwrap().push(ctx.to_string());
            Ok(format!("第{n}段"))
        }
    }

    impl AsrEngine for FakeEngine {
        fn framework(&self) -> &'static str {
            "fake"
        }
        fn load_model(&self, _name: &str) -> Result<(), String> {
            Ok(())
        }
        fn unload(&self) -> Result<(), String> {
            Ok(())
        }
        fn is_loaded(&self) -> bool {
            true
        }
        fn current_model(&self) -> String {
            "fake".into()
        }
        fn transcribe(&self, samples: &[f32], _rate: u32) -> Result<String, String> {
            self.record(samples, "")
        }
        fn transcribe_with_context(
            &self,
            samples: &[f32],
            _rate: u32,
            ctx: &str,
        ) -> Result<String, String> {
            self.record(samples, ctx)
        }
        fn vram_estimate_mb(&self) -> Option<u64> {
            None
        }
    }

    /// 接缝去重：真实样本（0.6B，130s 实录在 60s 处硬切；同一段音频两次识别且结果不一致）
    #[test]
    fn test_merge_by_text_real_seam() {
        let prev = "那会儿现在有个问题，在日常对话中偶尔还是会流露出现实社会的父权社会的话语。比如你赶紧整个男人下来，应该是现实社会一些对性别 的沉淀的话语。";
        let new = "社会一些对性别 的纯电的话语，在这个世界没有对应的存在，所以模型一进入到这种场景，就会自动把现实世界的父权的话语拿去用。";
        let m = merge_by_text(prev, new);
        let both_variants = m.contains("沉淀") && m.contains("纯电");
        assert!(!both_variants, "重叠区不得两版并存: {m}");
        assert!(m.contains("现实社会一些对性别"), "接缝前内容必须保留: {m}");
        assert!(m.contains("在这个世界没有对应的存在"), "接缝后内容必须保留: {m}");
        assert!(
            m.chars().count() < prev.chars().count() + new.chars().count(),
            "重复部分应被削掉: {m}"
        );
    }

    /// 无重叠 → 直接拼接（安全回退，不丢字）
    #[test]
    fn test_merge_by_text_no_overlap_concats() {
        assert_eq!(
            merge_by_text("今天天气不错。", "明天要下雨了。"),
            "今天天气不错。明天要下雨了。"
        );
    }

    /// 空输入边界
    #[test]
    fn test_merge_by_text_empty() {
        assert_eq!(merge_by_text("", "甲"), "甲");
        assert_eq!(merge_by_text("甲", ""), "甲");
    }

    /// 用户真的重复说 → 不得被当成重叠吞掉（min_match=6 的守卫）
    #[test]
    fn test_merge_by_text_keeps_genuine_short_repeat() {
        let m = merge_by_text("好的好的，我知道了。", "好的好的，那我们开始吧。");
        assert_eq!(m.matches("好的好的").count(), 2, "真重复应保留两份: {m}");
    }

    /// 跨段记忆：首段无上文，其后每段带「已累积文本尾部」（≤CTX_CHARS）
    #[test]
    fn test_memory_ctx_passed_per_segment() {
        let e = FakeEngine::new();
        let samples = vec![0.0f32; 130 * 16000]; // 64s + 64s + 10s → 3 段
        let text = transcribe_long(&e, &samples, 16000, &mut |_, _| {}).unwrap();
        assert_eq!(e.calls(), 3, "130s 应切 3 段");
        assert_eq!(text, "第1段第2段第3段");
        let ctxs = e.ctxs();
        assert!(ctxs[0].is_empty(), "首段不得带上文: {:?}", ctxs[0]);
        assert!(ctxs[1].contains("第1段"), "第二段应带第 1 段文本: {:?}", ctxs[1]);
        assert!(ctxs[2].contains("第2段"), "第三段应带前文: {:?}", ctxs[2]);
        assert!(ctxs[2].chars().count() <= CTX_CHARS, "上文长度须受限");
    }

    /// ctx_tail 边界
    #[test]
    fn test_ctx_tail() {
        assert_eq!(ctx_tail("", 5), "");
        assert_eq!(ctx_tail("甲乙", 5), "甲乙");
        assert_eq!(ctx_tail("甲乙丙丁", 2), "丙丁");
    }

    #[test]
    fn test_short_audio_single_call() {
        // 30s 音频 → 单次调用，不分段
        let e = FakeEngine::new();
        let samples = vec![0.0f32; 30 * 16000];
        let text = transcribe_long(&e, &samples, 16000, &mut |_, _| {}).unwrap();
        assert_eq!(text, "第1段");
        assert_eq!(e.calls(), 1);
    }

    #[test]
    fn test_300s_audio_5_chunks() {
        // 300s 音频 → 60s 步进，5 段 + 每段 4s 重叠
        let e = FakeEngine::new();
        let samples = vec![0.0f32; 300 * 16000];
        let mut progress: Vec<(f64, f64)> = Vec::new();
        let text = transcribe_long(&e, &samples, 16000, &mut |d, t| progress.push((d, t))).unwrap();
        // 合并语义：段间不再插 \n；各段文本无重叠 → 直接顺次拼接
        assert_eq!(text, "第1段第2段第3段第4段第5段");
        // 300s：offset 0,60,120,180,240 → 4 个满段 + 最后 60s 残留
        assert_eq!(e.calls(), 5, "300s 应切 5 段");
        // 每段长度：前 4 段 64s，最后一段 60s
        let recv = e.received.lock().unwrap();
        assert_eq!(recv.len(), 5);
        assert_eq!(recv[0], 64 * 16000);
        assert_eq!(recv[1], 64 * 16000);
        assert_eq!(recv[2], 64 * 16000);
        assert_eq!(recv[3], 64 * 16000);
        assert_eq!(recv[4], 60 * 16000);
        // 进度回调
        assert_eq!(progress.len(), 5);
        assert_eq!(progress[0].0, 60.0);
        assert_eq!(progress[0].1, 300.0);
        assert_eq!(progress[4].0, 300.0);
    }

    #[test]
    fn test_90s_audio_2_chunks() {
        // 90s：64s 满段 + 26s 残留（offset=60 → 剩 30s < 64s）
        let e = FakeEngine::new();
        let samples = vec![0.0f32; 90 * 16000];
        let text = transcribe_long(&e, &samples, 16000, &mut |_, _| {}).unwrap();
        assert_eq!(e.calls(), 2);
        let recv = e.received.lock().unwrap();
        assert_eq!(recv[0], 64 * 16000);
        assert_eq!(recv[1], 30 * 16000);
        assert!(text.contains("第1段"));
    }
}
