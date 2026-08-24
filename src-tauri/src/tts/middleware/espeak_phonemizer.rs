//! B 轨：Text → IPA（espeak-ng 标准路径 + 回退路由）
//!
//! `PhonemizerRouter` 是音素管道路由器：先把文本按 Unicode 范围分段，
//! 再为每段选择第一个 `can_handle` 通过的 provider，默认注册顺序：
//! [espeak-ng, 拼音回退, 英文直通]。
//!
//! - espeak-ng 可用（PATH 或随应用捆绑）：按**文本内容**自动选 voice（en-us/cmn/jap），
//!   从 stdin 产出 IPA。voice 跟随文本而非下拉语言，避免"英文文本被日文音素朗读"。
//! - 无 espeak-ng：中文走 `PinyinPhonemizer`（拼音 → IPA 回退），英文走 `PassthroughPhonemizer`

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use super::passthrough::PassthroughPhonemizer;
use super::pinyin::PinyinPhonemizer;
use super::vocab_mapper::ipa_to_token_ids;
use super::{segment_text, Phonemizer};

/// 探测 espeak-ng 可执行文件（PATH → 随应用捆绑 → 开发目录，缓存结果）
fn espeak_binary() -> Option<String> {
    static BIN: std::sync::LazyLock<Option<String>> = std::sync::LazyLock::new(|| {
        if let Ok(p) = which::which("espeak-ng") {
            return Some(p.to_string_lossy().into_owned());
        }
        for cand in bundled_candidates() {
            if cand.is_file() {
                return Some(cand.to_string_lossy().into_owned());
            }
        }
        None
    });
    BIN.clone()
}

/// 捆绑 espeak-ng 的候选路径（打包：exe 旁 / resource_dir；开发：resources/）
fn bundled_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            v.push(dir.join("espeak-ng/espeak-ng.exe"));
            v.push(dir.join("resources/espeak-ng/espeak-ng.exe"));
            v.push(dir.join("espeak-ng.exe"));
        }
    }
    v.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/espeak-ng/espeak-ng.exe"));
    v
}

/// espeak-ng 数据目录（espeak-ng-data 与二进制同目录）
fn espeak_data_dir(bin: &str) -> Option<PathBuf> {
    let d = std::path::Path::new(bin).parent()?.join("espeak-ng-data");
    d.is_dir().then_some(d)
}

/// espeak-ng G2P provider（标准 IPA 路径）
#[derive(Debug)]
pub struct EspeakPhonemizer {
    binary: Option<String>,
    data_dir: Option<PathBuf>,
}

impl EspeakPhonemizer {
    pub fn new() -> Self {
        let binary = espeak_binary();
        let data_dir = binary.as_deref().and_then(espeak_data_dir);
        Self { binary, data_dir }
    }

    /// 按文本内容自动选择 espeak voice（汉字→cmn，假名→jap，其余→en-us）
    fn resolve_voice(&self, text: &str) -> String {
        if text.chars().any(|c| matches!(c, '\u{4e00}'..='\u{9fff}')) {
            "cmn".to_string()
        } else if text.chars().any(|c| matches!(c, '\u{3040}'..='\u{30ff}')) {
            "jap".to_string()
        } else {
            "en-us".to_string()
        }
    }
}

impl Default for EspeakPhonemizer {
    fn default() -> Self {
        Self::new()
    }
}

impl Phonemizer for EspeakPhonemizer {
    fn name(&self) -> &str {
        "espeak"
    }

    fn can_handle(&self, _text: &str) -> bool {
        self.binary.is_some()
    }

    fn phonemize(&self, text: &str) -> Vec<String> {
        let Some(bin) = &self.binary else {
            return Vec::new();
        };
        if text.trim().is_empty() {
            return Vec::new();
        }
        let voice = self.resolve_voice(text);
        let mut cmd = Command::new(bin);
        cmd.args(["-v", voice.as_str(), "--ipa", "-q"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        if let Some(dir) = &self.data_dir {
            cmd.env("ESPEAK_DATA_PATH", dir);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
        let out = match child.wait_with_output() {
            Ok(o) => o,
            Err(_) => return Vec::new(),
        };
        if !out.status.success() {
            return Vec::new();
        }
        // IPA 输出按单个符号切分（含空格/换行分隔），交由下游 vocab 映射过滤
        String::from_utf8_lossy(&out.stdout)
            .chars()
            .filter(|c| !c.is_whitespace())
            .map(|c| c.to_string())
            .collect()
    }
}

/// B 轨路由：文本 → IPA token 序列（espeak-ng → 拼音回退 → 英文直通）
pub struct PhonemizerRouter {
    providers: Vec<Box<dyn Phonemizer>>,
}

impl PhonemizerRouter {
    /// 默认注册顺序：[espeak-ng, 拼音回退, 英文直通]
    pub fn new() -> Self {
        let mut r = Self { providers: Vec::new() };
        r.register(Box::new(EspeakPhonemizer::new()));
        r.register(Box::new(PinyinPhonemizer));
        r.register(Box::new(PassthroughPhonemizer));
        r
    }

    /// 追加 provider（优先级高于已注册的后续 provider）
    pub fn register(&mut self, p: Box<dyn Phonemizer>) {
        self.providers.push(p);
    }

    /// 选择第一个 can_handle 通过的 provider
    fn select(&self, text: &str) -> Option<&dyn Phonemizer> {
        self.providers
            .iter()
            .find(|p| p.can_handle(text))
            .map(|b| b.as_ref())
    }

    /// 文本 → 音素 token 序列（分段路由）
    pub fn phonemize(&self, text: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for (seg, _kind) in segment_text(text) {
            if seg.is_empty() {
                continue;
            }
            match self.select(seg) {
                Some(p) => out.extend(p.phonemize(seg)),
                // 无 provider 可处理（如标点）：直通原始字符，由 vocab 映射过滤
                None => out.extend(seg.chars().map(|c| c.to_string())),
            }
        }
        out
    }

    /// 文本 → token ids：先分段 G2P 成 IPA，再经 `vocab_mapper` 映射
    pub fn to_token_ids(&self, text: &str, vocab: &HashMap<String, u32>) -> Vec<i64> {
        let ipa = self.phonemize(text);
        ipa_to_token_ids(&ipa, vocab)
    }
}

impl Default for PhonemizerRouter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_not_available_is_noop() {
        // 未找到 espeak-ng 时 can_handle=false，phonemize 返回空
        let g = EspeakPhonemizer::new();
        if g.binary.is_none() {
            assert!(!g.can_handle("hello"));
            assert!(g.phonemize("hello").is_empty());
        }
    }

    #[test]
    fn test_router_mixed_text() {
        let router = PhonemizerRouter::new();
        // 中文 → espeak-cmn 或拼音回退，必须非空
        assert!(!router.phonemize("你好世界").is_empty());
        // 英文 → espeak IPA 或直通小写，必须非空
        assert!(!router.phonemize("Hello").is_empty());
    }

    /// 用真实 Kokoro tokenizer vocab 验证中英文都能产出有效 token ids
    #[test]
    fn test_chinese_and_english_token_ids_against_real_vocab() {
        let tk = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../models/Kokoro-82M/tokenizer.json");
        if !tk.exists() {
            eprintln!("tokenizer.json missing, skipping");
            return;
        }
        let data = std::fs::read_to_string(&tk).unwrap();
        let v: serde_json::Value = serde_json::from_str(&data).unwrap();
        let mut vocab: HashMap<String, u32> = HashMap::new();
        for (k, val) in v["model"]["vocab"].as_object().unwrap() {
            vocab.insert(k.clone(), val.as_u64().unwrap() as u32);
        }
        let router = PhonemizerRouter::new();
        // 中文：拼音回退 / espeak-cmn → IPA → vocab，必须产出实质内容（非仅边界 $）
        let zh = router.to_token_ids("你好世界", &vocab);
        assert!(zh.len() > 2, "Chinese 你好世界 should produce content, got {zh:?}");
        // 英文：espeak IPA 或直通
        let en = router.to_token_ids("Hello world", &vocab);
        assert!(en.len() > 2, "English Hello world should produce content, got {en:?}");
    }
}
