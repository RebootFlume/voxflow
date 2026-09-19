//! 长文本切分（TTS 分段合成的第一步）
//!
//! 与 ASR 侧的 `inference::transcribe_chunks::transcribe_long` 同构：短文本不分段，
//! 超过阈值才切。切点一律落在标点之后，尽量不破坏韵律：
//!   1. 优先句末标点（`。！？；!?;\n`）
//!   2. 退而求其次：句内标点（`，、：, ）`与空格）
//!   3. 都没有（超长英文串 / URL / 无标点长句）⇒ 按字符硬切
//!
//! 段大小同时决定两件事：**取消的生效延迟**与**进度粒度**（段内不可中断，见 `TtsCancel`）。

/// 每段目标字符数。CPU 上 RTF≈1.5，120 字约 25~30s 音频 ⇒ 单段约 40s，
/// 这也是「点了取消之后最多还要等多久」的上限。
pub const MAX_CHARS_PER_CHUNK: usize = 120;

/// 句末标点：切在这里最不伤韵律
const HARD_BREAKS: [char; 9] = ['。', '！', '？', '；', '!', '?', ';', '\n', '\r'];
/// 句内标点：没有句末标点时的退路
const SOFT_BREAKS: [char; 7] = ['，', '、', '：', ',', ':', '）', ')'];

/// 允许切出的最小段长，避免「嗯。」这种极短段（碎段会明显伤韵律）
fn min_cut(max_chars: usize) -> usize {
    (max_chars / 3).max(1)
}

/// 在 `limit` 个字符之内，找 `set` 里最后一个断点**之后**的字节位置。
/// 断点位置不足 `min_cut` 则不采用（宁可继续往下找或硬切）。
fn last_break_before(text: &str, limit: usize, set: &[char]) -> Option<usize> {
    let floor = min_cut(limit);
    let mut best: Option<usize> = None;
    for (count, (idx, ch)) in text.char_indices().enumerate() {
        if count >= limit {
            break;
        }
        if set.contains(&ch) && count + 1 >= floor {
            best = Some(idx + ch.len_utf8());
        }
    }
    best
}

/// 第 `n` 个字符处的字节偏移（不足则返回文本长度）
fn byte_index_of_char(text: &str, n: usize) -> usize {
    text.char_indices().nth(n).map(|(i, _)| i).unwrap_or(text.len())
}

/// 按标点切分长文本。
///
/// - 文本（去首尾空白后）不超过 `max_chars` ⇒ 返回单段，调用方据此走「不分段」路径，
///   与改造前的单次调用完全一致（短句零回归）。
/// - 切分只吃掉段间的空白字符，其余字符一个不丢。
pub fn split_text(text: &str, max_chars: usize) -> Vec<String> {
    let max_chars = max_chars.max(1);
    let mut out: Vec<String> = Vec::new();
    let mut rest = text.trim();

    while !rest.is_empty() {
        if rest.chars().count() <= max_chars {
            out.push(rest.trim().to_string());
            break;
        }
        let cut = last_break_before(rest, max_chars, &HARD_BREAKS)
            .or_else(|| last_break_before(rest, max_chars, &SOFT_BREAKS))
            .unwrap_or_else(|| byte_index_of_char(rest, max_chars));
        let (head, tail) = rest.split_at(cut);
        out.push(head.trim().to_string());
        rest = tail.trim_start();
    }

    out.retain(|s| !s.is_empty());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_single_chunk() {
        assert_eq!(split_text("你好，世界。", 120), vec!["你好，世界。"]);
        assert_eq!(split_text("  padded  ", 120), vec!["padded"]);
    }

    #[test]
    fn empty_input_yields_nothing() {
        assert!(split_text("", 120).is_empty());
        assert!(split_text("   \n\t ", 120).is_empty());
    }

    #[test]
    fn long_text_splits_after_sentence_marks() {
        let chunks = split_text("第一句话。第二句话。第三句话。", 6);
        assert!(chunks.len() > 1, "应切成多段: {chunks:?}");
        for c in &chunks {
            assert!(c.ends_with('。'), "段应结束在句末标点: {c}");
        }
    }

    #[test]
    fn falls_back_to_inner_punctuation() {
        // 全句无句末标点、只有逗号 ⇒ 切在逗号后
        let text = "这是一个很长很长很长的句子，它只用逗号分隔，没有任何句末标点";
        let chunks = split_text(text, 14);
        assert!(chunks.len() > 1);
        assert!(chunks[0].ends_with('，'), "第一段: {}", chunks[0]);
    }

    #[test]
    fn hard_cut_when_no_punctuation_at_all() {
        let text = "a".repeat(300);
        let chunks = split_text(&text, 120);
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|c| c.chars().count() <= 120));
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn nothing_is_lost_and_each_chunk_within_limit() {
        let text = "第一句，带逗号。第二句有点长，还有别的标点！第三句没有句末标点，最后一句";
        let chunks = split_text(text, 12);
        assert_eq!(chunks.concat(), text, "除段间空白外不得丢字符");
        for c in &chunks {
            assert!(c.chars().count() <= 12, "段超限: {c}");
        }
        // 无标点超长单句也必须硬切进阈值
        let messy = "无标点长句".repeat(50);
        assert!(split_text(&messy, 40).iter().all(|c| c.chars().count() <= 40));
    }

    #[test]
    fn avoids_tiny_head_segments() {
        // 句末标点出现在很靠前的位置时不应据此切出碎段
        let text = "好。这一段后面还有很长的内容需要继续说下去，不能切碎。";
        let chunks = split_text(text, 30);
        assert!(chunks[0].chars().count() >= min_cut(30), "碎段: {chunks:?}");
    }
}
