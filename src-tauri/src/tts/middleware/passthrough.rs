//! 英文直通（字母小写后逐字查 vocab，无需外部工具）
//!
//! Kokoro-82M 的音素表直接包含小写拉丁字母（a–z），因此英文文本
//! 无需真正 G2P：逐字符小写即可得到音素 token。
//!
//! ⚠️ 仅作 espeak-ng 不可用时的兜底：逐字母输出会丢失英语元音 IPA
//! （如 hello 应为 h ə l o ʊ，直通会产出 h e l l o），音质不自然。

use super::Phonemizer;

/// 英文直通（字母小写）
#[derive(Debug, Default)]
pub struct PassthroughPhonemizer;

impl Phonemizer for PassthroughPhonemizer {
    fn name(&self) -> &str {
        "passthrough"
    }

    fn can_handle(&self, text: &str) -> bool {
        !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric())
    }

    fn phonemize(&self, text: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for c in text.chars() {
            for lc in c.to_lowercase() {
                out.push(lc.to_string());
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_passthrough_english() {
        let g = PassthroughPhonemizer;
        assert!(g.can_handle("Hello"));
        assert!(!g.can_handle("你好"));
        assert!(!g.can_handle(""));
        assert_eq!(g.phonemize("Hello"), ["h", "e", "l", "l", "o"]);
        assert_eq!(g.phonemize("ABC"), ["a", "b", "c"]);
    }
}
