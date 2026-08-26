//! E2E 文本分词器：纯文本 → Token IDs（端到端直通）
//!
//! 无任何音素 / G2P / 语音词典参与：分词器直接装载模型自带的
//! `tokenizer.json` 的 `model.vocab`（token → id），对纯文本做
//! 整词优先、逐字符兜底的映射，未命中字符跳过。管道即
//! 「文本 → token ids → 端到端模型推理 → 波形」，中间无
//! 音素标注、语速调节、时长预测或重采样步骤。

use std::collections::HashMap;
use std::path::Path;

/// 端到端文本分词器（装载模型 tokenizer.json 的 vocab）
#[derive(Debug, Default)]
pub struct TextTokenizer {
    vocab: HashMap<String, u32>,
}

impl TextTokenizer {
    pub fn new() -> Self {
        Self { vocab: HashMap::new() }
    }

    /// vocab 是否已装载（未装载时 `encode` 返回空）
    pub fn is_empty(&self) -> bool {
        self.vocab.is_empty()
    }

    /// 装载的 vocab 条目数（日志 / 校验用）
    pub fn len(&self) -> usize {
        self.vocab.len()
    }

    /// 从 tokenizer.json 装载 vocab（`model.vocab`：token → id）
    pub fn load_tokenizer(&mut self, model_root: &Path, tokenizer_file: &str) {
        let p = model_root.join(tokenizer_file);
        let Ok(data) = std::fs::read_to_string(&p) else {
            eprintln!("[tts] WARNING: failed to read tokenizer {}", p.display());
            return;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
            eprintln!("[tts] WARNING: failed to parse tokenizer {}", p.display());
            return;
        };
        let Some(vocab) = v
            .get("model")
            .and_then(|m| m.get("vocab"))
            .and_then(|v| v.as_object())
        else {
            eprintln!("[tts] WARNING: no model.vocab in tokenizer");
            return;
        };
        self.vocab.clear();
        for (k, val) in vocab {
            if let Some(id) = val.as_u64() {
                self.vocab.insert(k.clone(), id as u32);
            }
        }
        eprintln!("[tts] loaded {} vocab entries", self.vocab.len());
    }

    /// 纯文本 → token ids：整词精确匹配优先，否则逐字符小写兜底，未命中跳过
    pub fn encode(&self, text: &str) -> Vec<i64> {
        if self.vocab.is_empty() || text.is_empty() {
            return Vec::new();
        }
        let mut ids: Vec<i64> = Vec::new();
        for word in text.split_whitespace() {
            // 整词精确匹配（含剥离首尾标点的尝试）
            let word = word.trim_matches(|c: char| c.is_ascii_punctuation() || c.is_whitespace());
            if word.is_empty() {
                continue;
            }
            if let Some(&id) = self.vocab.get(word) {
                ids.push(id as i64);
                continue;
            }
            // 逐字符（含小写）兜底
            for ch in word.chars() {
                let mut matched = false;
                for c in ch.to_lowercase() {
                    if let Some(&id) = self.vocab.get(&c.to_string()) {
                        ids.push(id as i64);
                        matched = true;
                    }
                }
                if !matched {
                    if let Some(&id) = self.vocab.get(&ch.to_string()) {
                        ids.push(id as i64);
                    }
                }
            }
        }
        ids
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vocab() -> HashMap<String, u32> {
        let mut v = HashMap::new();
        for (i, k) in ["hello", "h", "e", "l", "o", "你", "好"].iter().enumerate() {
            v.insert(k.to_string(), i as u32);
        }
        v
    }

    #[test]
    fn test_encode_whole_word_first() {
        let t = TextTokenizer { vocab: vocab() };
        // 整词 "hello" 命中一次，而不是逐字符 5 次
        assert_eq!(t.encode("hello"), vec![0]);
    }

    #[test]
    fn test_encode_char_fallback() {
        let t = TextTokenizer { vocab: vocab() };
        // "hell" 非整词 → 逐字符 h(1),e(2),l(3),l(3)
        let ids = t.encode("hell");
        assert_eq!(ids, vec![1, 2, 3, 3]);
    }

    #[test]
    fn test_encode_unknown_skipped() {
        let t = TextTokenizer { vocab: vocab() };
        // "你好" 逐字符命中；"zz" 未命中跳过 → 空
        assert_eq!(t.encode("你好"), vec![5, 6]);
        assert_eq!(t.encode("zz"), Vec::<i64>::new());
    }

    #[test]
    fn test_encode_empty() {
        let t = TextTokenizer::new();
        assert!(t.is_empty());
        assert_eq!(t.encode(""), Vec::<i64>::new());
        assert_eq!(t.encode("abc"), Vec::<i64>::new());
    }
}
