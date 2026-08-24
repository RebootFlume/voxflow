//! TTS 文本处理中间件（可复用原子步骤，全局仅此一套）
//!
//! - `espeak_phonemizer`（B 轨）：Text → IPA（espeak-ng + 拼音回退 + 英文直通）
//! - `vocab_mapper`（B 轨）：IPA → Token IDs
//! - `direct_tokenizer`（A 轨）：Text → Token IDs（Direct 管道，尚未接入 HF tokenizer）
//!
//! 中间件只做「文本/音素/Token」转换，不感知具体模型；模型差异由
//! `ModelManifest` 配置（见 `crate::tts::config`）表达。

pub mod direct_tokenizer;
pub mod espeak_phonemizer;
pub mod passthrough;
pub mod pinyin;
pub mod vocab_mapper;

pub use espeak_phonemizer::{EspeakPhonemizer, PhonemizerRouter};
pub use passthrough::PassthroughPhonemizer;
pub use pinyin::PinyinPhonemizer;

/// G2P provider trait：文本 → 音素 token 序列
pub trait Phonemizer: Send + Sync {
    /// provider 名称（日志/调试用）
    fn name(&self) -> &str;
    /// 该 provider 是否能处理这段文本
    fn can_handle(&self, text: &str) -> bool;
    /// 把文本转成音素 token 序列（单字符 IPA 符号；未命中 vocab 的符号由下游过滤）
    fn phonemize(&self, text: &str) -> Vec<String>;
}

/// 文本片段类型（按 Unicode 范围分类）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentKind {
    /// 拉丁字母/数字（英文等）
    Latin,
    /// 汉字（CJK 统一表意文字）
    Han,
    /// 假名（日文）
    Kana,
    /// 标点/空白/其它
    Punct,
}

fn classify(c: char) -> SegmentKind {
    if c.is_ascii_alphanumeric() {
        SegmentKind::Latin
    } else if matches!(
        c,
        '\u{4e00}'..='\u{9fff}' | '\u{3400}'..='\u{4dbf}' | '\u{f900}'..='\u{faff}'
    ) {
        SegmentKind::Han
    } else if matches!(c, '\u{3040}'..='\u{30ff}' | '\u{31f0}'..='\u{31ff}') {
        SegmentKind::Kana
    } else {
        SegmentKind::Punct
    }
}

/// 按 Unicode 范围把文本切成连续片段（en/zh/ja/punct）
pub fn segment_text(text: &str) -> Vec<(&str, SegmentKind)> {
    let mut out: Vec<(&str, SegmentKind)> = Vec::new();
    let mut start = 0usize;
    let mut cur: Option<SegmentKind> = None;
    for (i, c) in text.char_indices() {
        let k = classify(c);
        match cur {
            Some(ck) if ck == k => {}
            Some(ck) => {
                out.push((&text[start..i], ck));
                start = i;
                cur = Some(k);
            }
            None => cur = Some(k),
        }
    }
    if let Some(ck) = cur {
        out.push((&text[start..], ck));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_segment_text_mixed() {
        let segs = segment_text("Hello世界123");
        assert_eq!(segs.len(), 3);
        assert_eq!(segs[0], ("Hello", SegmentKind::Latin));
        assert_eq!(segs[1], ("世界", SegmentKind::Han));
        assert_eq!(segs[2], ("123", SegmentKind::Latin));
    }

    #[test]
    fn test_segment_text_punct() {
        let segs = segment_text("Hi, 世界!");
        assert_eq!(segs.len(), 4);
        assert_eq!(segs[0], ("Hi", SegmentKind::Latin));
        assert_eq!(segs[1], (", ", SegmentKind::Punct));
        assert_eq!(segs[2], ("世界", SegmentKind::Han));
        assert_eq!(segs[3], ("!", SegmentKind::Punct));
    }
}
