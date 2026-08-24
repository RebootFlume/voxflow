//! B 轨：IPA → Token IDs（音素 → vocab id 映射）
//!
//! 把 `espeak_phonemizer` 产出的 IPA token 序列映射到模型 tokenizer
//! vocab（`phoneme_to_id`），首尾加边界符 `$`（Kokoro 的序列起止标记）。
//! 未命中 vocab 的音素直接跳过（如 espeak-ng 产出的非白名单符号）。

use std::collections::HashMap;

/// IPA token 序列 → token ids（首尾加边界符 `$`，未命中 vocab 的音素跳过）
pub fn ipa_to_token_ids(ipa: &[String], vocab: &HashMap<String, u32>) -> Vec<i64> {
    let mut ids: Vec<i64> = Vec::with_capacity(ipa.len() + 2);
    if let Some(&id) = vocab.get("$") {
        ids.push(id as i64);
    }
    for tok in ipa {
        if let Some(&id) = vocab.get(tok) {
            ids.push(id as i64);
        }
    }
    if let Some(&id) = vocab.get("$") {
        ids.push(id as i64);
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vocab() -> HashMap<String, u32> {
        let mut v = HashMap::new();
        for (i, k) in ["$", "a", "h", "o"].iter().enumerate() {
            v.insert(k.to_string(), i as u32);
        }
        v
    }

    #[test]
    fn test_maps_known_and_skips_unknown() {
        let v = vocab();
        let ipa = ["h".to_string(), "a".to_string(), "x".to_string(), "o".to_string()];
        let ids = ipa_to_token_ids(&ipa, &v);
        // $ h a o $ → [0, 2, 1, 3, 0]（x 未命中跳过）
        assert_eq!(ids, vec![0, 2, 1, 3, 0]);
    }

    #[test]
    fn test_all_unknown_yields_only_boundaries() {
        let v = vocab();
        let ipa = ["x".to_string(), "y".to_string()];
        assert_eq!(ipa_to_token_ids(&ipa, &v), vec![0, 0]);
    }
}
