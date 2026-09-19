//! ArgSpec 解释器：模型描述符 → CLI argv（无模型分支）
//!
//! 解释器遍历 `SherpaTtsSpec.cli`（`Vec<ArgSpec>`）拼 argv，顺序 = 描述符声明顺序。
//! 路径类参数相对「模型目录」；`ModelsRootFile` 相对「models 根目录」。
//! 与旧 `SherpaTtsEngine::cli_args` 的等价性：P2 迁移期曾用 diff 测试逐模型验证一致
//! （8/8 通过），旧实现删除后由 `tests::test_argv_golden_frozen` 冻结黄金值守护。

use std::path::{Path, PathBuf};

use super::super::spec::{ArgSpec, RuntimeKey, SherpaTtsSpec};

/// 解释器运行时环境（合成时按当前状态填充）
pub struct ArgEnv<'a> {
    /// 模型目录（models_root / spec.id）
    pub model_dir: &'a Path,
    /// models 根目录（ModelsRootFile 用）
    pub models_root: &'a Path,
    /// 推理提供者（"cpu" / "cuda"）
    pub provider: &'a str,
    /// 推理线程数
    pub num_threads: i32,
    /// 说话人 id（--sid）
    pub sid: i32,
    /// 语言（--lang，Supertonic）
    pub language: &'a str,
    /// 输出文件路径（--output-filename）
    pub output: &'a Path,
    /// 语音克隆参考音频（--reference-audio）
    pub reference_audio: Option<&'a Path>,
    /// 语音克隆参考文本（--reference-text）
    pub reference_text: Option<&'a str>,
}

/// 主模型文件解析：model.onnx 优先，回退 model-steps-*.onnx 取最大（Matcha 官方包）
pub fn main_model_file(dir: &Path) -> PathBuf {
    let standard = dir.join("model.onnx");
    if standard.exists() {
        return standard;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut steps: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let name = p
                    .file_name()
                    .map(|n| n.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                name.starts_with("model-steps-") && name.ends_with(".onnx")
            })
            .collect();
        if !steps.is_empty() {
            steps.sort_by_key(|p| p.metadata().map(|m| m.len()).unwrap_or(0));
            return steps.pop().unwrap();
        }
    }
    standard
}

/// 描述符 → argv（模型专用参数；`--output-filename` 与 text 由调用方追加，与旧实现一致）
/// 描述符声明"必须存在"的文件里，当前磁盘上缺失的（返回人话名字，用于加载/合成前预检）。
///
/// 覆盖三处来源：`required_files`、`ArgSpec::File`（相对模型目录）、
/// `ArgSpec::ModelsRootFile`（相对 models 根，如 ZipVoice/Matcha 的 vocoder）。
/// `OptionalFile` / `JoinableFiles` 的语义本来就是"没有就不加参数"，不在检查范围。
///
/// 为什么要它：sherpa-onnx 自己的配置校验只给一句 `Errors in config!`（用户实际撞到的就是这条，
/// 真因是 Matcha 缺 vocoder + 传了不存在的 `--matcha-data-dir`），由这里提前说清缺的是哪个文件。
pub fn missing_files(spec: &SherpaTtsSpec, env: &ArgEnv) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // 用 `exists()` 而非 `is_file()`：描述符里的路径**可以指向目录**
    //（Kokoro / ZipVoice 的 `espeak-ng-data` 就是目录）——用 is_file() 会把存在的目录误判成缺失。
    for f in spec.required_files {
        if !env.model_dir.join(f).exists() {
            out.push((*f).to_string());
        }
    }
    for arg in spec.cli {
        match arg {
            ArgSpec::File(_, rel) if !env.model_dir.join(rel).exists() => {
                out.push((*rel).to_string());
            }
            ArgSpec::ModelsRootFile(_, rel) if !env.models_root.join(rel).exists() => {
                out.push(format!("{rel}（模型公共文件，需随模型一起下载）"));
            }
            _ => {}
        }
    }
    out.sort();
    out.dedup();
    out
}

pub fn build_argv(spec: &SherpaTtsSpec, env: &ArgEnv) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    for arg in spec.cli {
        match arg {
            ArgSpec::Static(flag, val) => args.push(format!("{flag}={val}")),
            ArgSpec::File(flag, rel) => {
                args.push(format!("{flag}={}", env.model_dir.join(rel).display()));
            }
            ArgSpec::OptionalFile(flag, rel) => {
                let p = env.model_dir.join(rel);
                if p.exists() {
                    args.push(format!("{flag}={}", p.display()));
                }
            }
            ArgSpec::JoinableFiles(flag, rels, sep) => {
                let joined: Vec<String> = rels
                    .iter()
                    .filter(|r| env.model_dir.join(r).exists())
                    .map(|r| env.model_dir.join(r).display().to_string())
                    .collect();
                if !joined.is_empty() {
                    args.push(format!("{flag}={}", joined.join(&sep.to_string())));
                }
            }
            ArgSpec::ModelsRootFile(flag, rel) => {
                args.push(format!("{flag}={}", env.models_root.join(rel).display()));
            }
            ArgSpec::RuntimeVar(flag, key) => {
                let val = match key {
                    RuntimeKey::SpeakerId => env.sid.to_string(),
                    RuntimeKey::Language => env.language.to_string(),
                    RuntimeKey::Provider => env.provider.to_string(),
                    RuntimeKey::NumThreads => env.num_threads.to_string(),
                    RuntimeKey::OutputPath => env.output.display().to_string(),
                    RuntimeKey::ReferenceAudio => match env.reference_audio {
                        Some(p) => p.display().to_string(),
                        None => continue,
                    },
                    RuntimeKey::ReferenceText => match env.reference_text {
                        Some(t) => t.to_string(),
                        None => continue,
                    },
                    RuntimeKey::MainModelFile => main_model_file(env.model_dir).display().to_string(),
                };
                args.push(format!("{flag}={val}"));
            }
        }
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tts::spec::{ArgSpec, BackendSpec, ModelSpec, RuntimeKey, SherpaTtsSpec};

    /// 归一化：路径前缀 → 占位符，分隔符统一为 `/`（跨平台确定）
    fn normalize(argv: &[String], dir: &Path, root: &Path) -> Vec<String> {
        let d = dir.display().to_string();
        let r = root.display().to_string();
        argv.iter()
            .map(|a| a.replace(&d, "<DIR>").replace(&r, "<ROOT>").replace('\\', "/"))
            .collect()
    }

    /// 构造合成模型目录（写入全部声明文件）→ argv 与真实文件系统状态解耦，跨机器确定
    fn synthetic_dir(spec: &ModelSpec) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("voxflow_argv_{}", spec.id));
        let _ = std::fs::create_dir_all(&dir);
        let BackendSpec::SherpaTts(ts) = &spec.backend else {
            return dir;
        };
        for f in ts.required_files {
            let _ = std::fs::write(dir.join(f), b"x");
        }
        for arg in ts.cli {
            match arg {
                ArgSpec::File(_, p) => {
                    let _ = std::fs::write(dir.join(p), b"x");
                }
                ArgSpec::JoinableFiles(_, cands, _) => {
                    for c in *cands {
                        let _ = std::fs::write(dir.join(c), b"x");
                    }
                }
                _ => {}
            }
        }
        let _ = std::fs::write(dir.join("model.onnx"), b"x");
        dir
    }

    #[test]
    fn missing_files_reports_vocoder_and_acoustic_model() {
        // 用具名 fn 而非闭包：闭包无法表达 "两个入参引用与返回值同寿命"
        fn env_of<'a>(dir: &'a Path, root: &'a Path) -> ArgEnv<'a> {
            ArgEnv {
                model_dir: dir,
                models_root: root,
                provider: "cpu",
                num_threads: 2,
                sid: 0,
                language: "zh",
                output: Path::new("<OUT>"),
                reference_audio: None,
                reference_text: None,
            }
        }

        let spec = ModelSpec::find("matcha-icefall-zh-baker").expect("matcha spec 存在");
        let BackendSpec::SherpaTts(ts) = &spec.backend else {
            panic!("matcha 应是 sherpa 后端");
        };

        // 空目录 + 空模型根：vocoder（模型根）与声学模型/lexicon 都应被报出来
        let dir = std::env::temp_dir().join("voxflow_missing_matcha");
        let root = std::env::temp_dir().join("voxflow_missing_root");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let missing = missing_files(&ts, &env_of(&dir, &root));
        assert!(
            missing.iter().any(|m| m.starts_with("vocos-22khz-univ.onnx")),
            "缺 vocoder 必须报出来: {missing:?}"
        );
        assert!(missing.iter().any(|m| m == "model-steps-3.onnx"), "{missing:?}");
        assert!(missing.iter().any(|m| m == "lexicon.txt"), "{missing:?}");

        // 文件齐了之后不再报
        for f in ["model-steps-3.onnx", "tokens.txt", "lexicon.txt"] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        std::fs::write(root.join("vocos-22khz-univ.onnx"), b"x").unwrap();
        assert!(missing_files(&ts, &env_of(&dir, &root)).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 黄金比对：8 个 TTS 模型的 argv 逐项冻结（顺序/flag/多候选 join 顺序/跳过语义）
    /// 迁移期曾与旧 cli_args 逐模型 diff 一致（8/8），此测试守护其不被改动。
    #[test]
    fn test_argv_golden_frozen() {
        let root = std::path::Path::new("<ROOT>");
        let out = std::path::Path::new("<OUT>");

        let cases: &[(&str, &[&str])] = &[
            (
                "kokoro-multi-lang-v1_1",
                &[
                    "--kokoro-model=<DIR>/model.onnx",
                    "--kokoro-voices=<DIR>/voices.bin",
                    "--kokoro-tokens=<DIR>/tokens.txt",
                    "--kokoro-data-dir=<DIR>/espeak-ng-data",
                    "--kokoro-lexicon=<DIR>/lexicon-us-en.txt,<DIR>/lexicon-gb-en.txt,<DIR>/lexicon-zh.txt",
                    "--tts-rule-fsts=<DIR>/date-zh.fst,<DIR>/phone-zh.fst,<DIR>/number-zh.fst",
                    "--sid=0",
                    "--provider=cuda",
                    "--num-threads=4",
                ],
            ),
            (
                "kokoro-multi-lang-v1_0",
                &[
                    "--kokoro-model=<DIR>/model.onnx",
                    "--kokoro-voices=<DIR>/voices.bin",
                    "--kokoro-tokens=<DIR>/tokens.txt",
                    "--kokoro-data-dir=<DIR>/espeak-ng-data",
                    "--kokoro-lexicon=<DIR>/lexicon-us-en.txt,<DIR>/lexicon-gb-en.txt,<DIR>/lexicon-zh.txt",
                    "--tts-rule-fsts=<DIR>/date-zh.fst,<DIR>/phone-zh.fst,<DIR>/number-zh.fst",
                    "--sid=0",
                    "--provider=cuda",
                    "--num-threads=4",
                ],
            ),
            (
                // 修正：英文包不含中文词表/规则（官方 Python/C/C++ 示例连 en 词表都不传），
                // 原来给这个模型塞 lexicon-zh.txt + 三个 zh FST ⇒ 参数无意义，且 required 校验
                // 把 lexicon-zh.txt 当必需文件 ⇒ 已下载的包永远被判"缺文件"。
                "kokoro-en-v0_19",
                &[
                    "--kokoro-model=<DIR>/model.onnx",
                    "--kokoro-voices=<DIR>/voices.bin",
                    "--kokoro-tokens=<DIR>/tokens.txt",
                    "--kokoro-data-dir=<DIR>/espeak-ng-data",
                    "--kokoro-lexicon=<DIR>/lexicon-us-en.txt,<DIR>/lexicon-gb-en.txt",
                    "--sid=0",
                    "--provider=cuda",
                    "--num-threads=4",
                ],
            ),
            (
                // 修正：原来传的 `--matcha-data-dir=<DIR>/espeak-ng-data` 让 sherpa-onnx 忽略
                // `--matcha-lexicon`（见 CLI --help 对该参数的说明），而本模型目录没有 espeak-ng-data
                // ⇒ 合成时 CLI 直接报 "Errors in config!"。改为 vocoder（模型根，另下载）+ lexicon
                // + `--tts-rule-fsts`（中文正则；通用 flag，非 matcha 前缀）。
                "matcha-icefall-zh-baker",
                &[
                    "--matcha-acoustic-model=<DIR>/model.onnx",
                    "--matcha-vocoder=<ROOT>/vocos-22khz-univ.onnx",
                    "--matcha-tokens=<DIR>/tokens.txt",
                    "--matcha-lexicon=<DIR>/lexicon.txt",
                    "--tts-rule-fsts=<DIR>/date.fst,<DIR>/number.fst,<DIR>/phone.fst",
                    "--sid=0",
                    "--provider=cuda",
                    "--num-threads=4",
                ],
            ),
            (
                "sherpa-onnx-zipvoice-distill",
                &[
                    "--zipvoice-encoder=<DIR>/encoder.int8.onnx",
                    "--zipvoice-decoder=<DIR>/decoder.int8.onnx",
                    "--zipvoice-lexicon=<DIR>/lexicon.txt",
                    "--zipvoice-tokens=<DIR>/tokens.txt",
                    "--zipvoice-data-dir=<DIR>/espeak-ng-data",
                    "--zipvoice-vocoder=<ROOT>/vocos_24khz.onnx",
                    "--provider=cuda",
                    "--num-threads=4",
                ],
            ),
            (
                "sherpa-onnx-pocket-tts-int8",
                &[
                    "--pocket-lm-flow=<DIR>/lm_flow.int8.onnx",
                    "--pocket-lm-main=<DIR>/lm_main.int8.onnx",
                    "--pocket-encoder=<DIR>/encoder.onnx",
                    "--pocket-decoder=<DIR>/decoder.onnx",
                    "--pocket-tokens=<DIR>/tokens.txt",
                    "--pocket-data-dir=<DIR>/espeak-ng-data",
                    "--provider=cuda",
                    "--num-threads=4",
                ],
            ),
            (
                "sherpa-onnx-supertonic-3-tts-int8",
                &[
                    "--supertonic-duration-predictor=<DIR>/duration_predictor.int8.onnx",
                    "--supertonic-text-encoder=<DIR>/text_encoder.int8.onnx",
                    "--supertonic-vector-estimator=<DIR>/vector_estimator.int8.onnx",
                    "--supertonic-vocoder=<DIR>/vocoder.int8.onnx",
                    "--supertonic-tts-json=<DIR>/tts.json",
                    "--supertonic-unicode-indexer=<DIR>/unicode_indexer.bin",
                    "--supertonic-voice-style=<DIR>/voice.bin",
                    "--sid=0",
                    "--lang=zh",
                    "--provider=cuda",
                    "--num-threads=4",
                ],
            ),
            (
                "kitten-nano-en-v0_1-fp16",
                &[
                    "--kitten-model=<DIR>/model.onnx",
                    "--kitten-tokens=<DIR>/tokens.txt",
                    "--sid=0",
                    "--provider=cuda",
                    "--num-threads=4",
                ],
            ),
        ];

        for (id, expected) in cases {
            let spec = ModelSpec::find(id).unwrap_or_else(|| panic!("spec 缺 {id}"));
            let BackendSpec::SherpaTts(ts) = &spec.backend else {
                panic!("{id} 不是 SherpaTts 后端");
            };
            let dir = synthetic_dir(spec);
            let env = ArgEnv {
                model_dir: &dir,
                models_root: root,
                provider: "cuda",
                num_threads: 4,
                sid: 0,
                language: "zh",
                output: out,
                reference_audio: None,
                reference_text: None,
            };
            let argv = build_argv(ts, &env);
            let got = normalize(&argv, &dir, root);
            let want: Vec<String> = expected.iter().map(|s| s.to_string()).collect();
            assert_eq!(got, want, "{id} argv 黄金值不一致");
        }
    }

    /// 解释器语义：可选文件缺失则跳过；克隆参数缺失则跳过；占位符按运行时填充
    #[test]
    fn test_argv_variants_semantics() {
        static CLI: &[ArgSpec] = &[
            ArgSpec::Static("--fixed", "1"),
            ArgSpec::OptionalFile("--opt", "opt.bin"),
            ArgSpec::JoinableFiles("--join", &["a.txt", "b.txt"], ','),
            ArgSpec::ModelsRootFile("--root-file", "vocos.onnx"),
            ArgSpec::RuntimeVar("--sid", RuntimeKey::SpeakerId),
            ArgSpec::RuntimeVar("--lang", RuntimeKey::Language),
            ArgSpec::RuntimeVar("--provider", RuntimeKey::Provider),
            ArgSpec::RuntimeVar("--num-threads", RuntimeKey::NumThreads),
            ArgSpec::RuntimeVar("--reference-audio", RuntimeKey::ReferenceAudio),
            ArgSpec::RuntimeVar("--reference-text", RuntimeKey::ReferenceText),
            ArgSpec::RuntimeVar("--out", RuntimeKey::OutputPath),
        ];
        let spec = SherpaTtsSpec {
            cli: CLI,
            required_files: &[],
        };
        let dir = std::env::temp_dir().join(format!(
            "voxflow_argv_variants_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("a.txt"), b"x");
        let root = std::path::Path::new("<ROOT>");
        let out = std::path::Path::new("<OUT>");

        // 无克隆参数、opt.bin 缺失、join 仅 a.txt → 跳过项不出现
        let env = ArgEnv {
            model_dir: &dir,
            models_root: root,
            provider: "cpu",
            num_threads: 2,
            sid: 7,
            language: "en",
            output: out,
            reference_audio: None,
            reference_text: None,
        };
        let argv = build_argv(&spec, &env);
        let got = normalize(&argv, &dir, root);
        assert_eq!(
            got,
            vec![
                "--fixed=1",
                "--join=<DIR>/a.txt",
                "--root-file=<ROOT>/vocos.onnx",
                "--sid=7",
                "--lang=en",
                "--provider=cpu",
                "--num-threads=2",
                "--out=<OUT>",
            ]
        );

        // 克隆参数存在 → 出现；opt.bin 存在 → 出现
        let _ = std::fs::write(dir.join("opt.bin"), b"x");
        let _ = std::fs::write(dir.join("b.txt"), b"x");
        let clone = std::path::Path::new("<REF>.wav");
        let env2 = ArgEnv {
            reference_audio: Some(clone),
            reference_text: Some("参考文本"),
            ..env
        };
        let got2 = normalize(&build_argv(&spec, &env2), &dir, root);
        assert!(got2.contains(&"--opt=<DIR>/opt.bin".to_string()));
        assert!(got2.contains(&"--join=<DIR>/a.txt,<DIR>/b.txt".to_string()));
        assert!(got2.contains(&"--reference-audio=<REF>.wav".to_string()));
        assert!(got2.contains(&"--reference-text=参考文本".to_string()));
    }
}
