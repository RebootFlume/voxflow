//! 8 模型 TTS 冒烟矩阵（描述符驱动，方案文档 §8 P2「8 模型加载/合成冒烟」）
//!
//! 模型来源 = `tts::spec::SPECS` 中全部 `kind == Tts` 条目（不写死模型名单：
//! 将来新增 TTS 模型自动纳入矩阵，缩水由 `tts_matrix_source_is_specs` 拦住）。
//! 每个模型独立执行 `load` → 中/英各一句 `synthesize` → 断言 samples 非空 + sample_rate > 0，
//! 结果统一收集后一次性 `assert!`（失败信息带模型名），并打印 passed / skipped / failed 汇总。
//!
//! 用法：
//! - 默认（无模型环境，CI）：只跑矩阵数据源校验 —— `cargo test --test tts_models_smoke`
//! - 真机冒烟：`cargo test --test tts_models_smoke -- --ignored --nocapture`
//! - 覆盖设备 / 音色：`VOXFLOW_TTS_DEVICE=cuda`（默认 `cpu`）、`VOXFLOW_TTS_VOICE=45`（默认 `0`）

use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;

use voxflow_lib::tts::registry::TtsRegistry;
use voxflow_lib::tts::spec::{ModelKind, ModelSpec, SPECS};
use voxflow_lib::tts::traits::SynthAudio;

/// 矩阵数据源：`SPECS` 里的 TTS 条目（顺序 = 描述符表顺序）
fn tts_specs() -> Vec<&'static ModelSpec> {
    SPECS.iter().filter(|m| m.kind == ModelKind::Tts).collect()
}

/// 模型目录（与 `TtsRegistry::load` 内部一致的 models_root / spec.id）
fn model_dir(spec: &ModelSpec) -> PathBuf {
    voxflow_lib::model_manager::get_model_root().join(spec.id)
}

/// 单模型冒烟：load → 中英各一句合成，返回 (中文 samples/rate, 英文 samples/rate)
fn synthesize_one(
    registry: &TtsRegistry,
    spec: &ModelSpec,
    device: &str,
    voice: &str,
) -> Result<((usize, u32), (usize, u32)), String> {
    registry
        .load(spec.name, device)
        .map_err(|e| format!("load({}, device={device}) 失败: {e}", spec.name))?;
    let engine = registry
        .active()
        .ok_or_else(|| format!("load 返回成功但 active() 为空（{}）", spec.name))?;
    if engine.name() != spec.id {
        return Err(format!(
            "路由不一致：引擎 name={} 但期望 spec.id={}",
            engine.name(),
            spec.id
        ));
    }

    let zh = engine
        .synthesize("你好，这是语音合成测试。", voice)
        .map_err(|e| format!("中文合成失败（voice={voice}）: {e}"))?;
    check_audio(&zh, spec, "中文")?;

    let en = engine
        .synthesize("Hello, this is a short test.", voice)
        .map_err(|e| format!("英文合成失败（voice={voice}）: {e}"))?;
    check_audio(&en, spec, "英文")?;

    Ok((
        (zh.samples.len(), zh.sample_rate),
        (en.samples.len(), en.sample_rate),
    ))
}

/// 合成结果断言：非空 PCM + 引擎声明的合法采样率
fn check_audio(audio: &SynthAudio, spec: &ModelSpec, label: &str) -> Result<(), String> {
    if audio.samples.is_empty() {
        return Err(format!("{label}合成返回空 samples（{}）", spec.name));
    }
    if audio.sample_rate == 0 {
        return Err(format!("{label}合成 sample_rate=0（{}）", spec.name));
    }
    Ok(())
}

fn panic_text(payload: &(dyn Any + Send)) -> &str {
    if let Some(s) = payload.downcast_ref::<&str>() {
        s
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.as_str()
    } else {
        "<非字符串 panic>"
    }
}

/// 矩阵数据源校验（无需模型 / 网络，默认运行）：
/// 保证冒烟矩阵确实覆盖 `SPECS` 的 TTS 条目且每条都能按名字路由 —— 防止矩阵静默失效。
#[test]
fn tts_matrix_source_is_specs() {
    let specs = tts_specs();

    assert!(
        specs.len() >= 8,
        "SPECS 中 kind=Tts 条目应 ≥ 8（矩阵不得静默缩水），实际 {}",
        specs.len()
    );
    assert_eq!(
        specs.len(),
        ModelSpec::all_tts().len(),
        "SPECS 过滤结果必须与 ModelSpec::all_tts() 一致"
    );

    for spec in &specs {
        // 矩阵用展示名调 load → 必须能被 find 解析回同一条目
        assert_eq!(
            ModelSpec::find(spec.name).map(|m| m.id),
            Some(spec.id),
            "find 无法按展示名 {} 路由",
            spec.name
        );
        assert_eq!(
            ModelSpec::find(spec.id).map(|m| m.id),
            Some(spec.id),
            "find 无法按 id {} 路由",
            spec.id
        );
        assert!(
            !spec.id.is_empty() && !spec.name.is_empty(),
            "TTS 条目的 id/name 不得为空"
        );
    }

    // id 唯一（重复会让 model_dir / 路由产生歧义）
    let mut ids: Vec<&str> = specs.iter().map(|s| s.id).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), specs.len(), "TTS spec id 必须唯一");
}

/// 真机冒烟矩阵：遍历全部 TTS 条目，缺模型记 skip 而非失败；结果收集后统一断言。
#[test]
#[ignore = "需本机已下载模型；cargo test --test tts_models_smoke -- --ignored --nocapture"]
fn tts_models_smoke_matrix() {
    let device = std::env::var("VOXFLOW_TTS_DEVICE").unwrap_or_else(|_| "cpu".to_string());
    let voice = std::env::var("VOXFLOW_TTS_VOICE").unwrap_or_else(|_| "0".to_string());

    let specs = tts_specs();
    println!(
        "[smoke] {} 个 TTS 模型（device={device}, voice={voice}）",
        specs.len()
    );

    let registry = TtsRegistry::new();
    let mut passed: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();

    for spec in &specs {
        let dir = model_dir(spec);
        if !dir.exists() {
            let line = format!("{}（目录缺失: {}）", spec.name, dir.display());
            println!("[skip] {line}");
            skipped.push(line);
            continue;
        }

        // 每模型独立隔离：引擎/动态库级 panic 只影响该模型，矩阵继续
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            synthesize_one(&registry, spec, &device, &voice)
        }));

        match outcome {
            Ok(Ok((zh, en))) => {
                let line = format!(
                    "{}（中 {} samples @ {}Hz；英 {} samples @ {}Hz）",
                    spec.name, zh.0, zh.1, en.0, en.1
                );
                println!("[pass] {line}");
                passed.push(line);
            }
            Ok(Err(e)) => {
                let line = format!("{}：{e}", spec.name);
                println!("[fail] {line}");
                failed.push(line);
            }
            Err(payload) => {
                let line = format!("{}：panic {}", spec.name, panic_text(payload.as_ref()));
                println!("[fail] {line}");
                failed.push(line);
            }
        }
    }

    println!("\n===== TTS 冒烟汇总（passed {} / skipped {} / failed {}）=====", passed.len(), skipped.len(), failed.len());
    for l in &passed {
        println!("  [PASS] {l}");
    }
    for l in &skipped {
        println!("  [SKIP] {l}");
    }
    for l in &failed {
        println!("  [FAIL] {l}");
    }
    println!("==========================================================");

    assert!(
        failed.is_empty(),
        "TTS 冒烟失败 {} 个：\n{}",
        failed.len(),
        failed.join("\n")
    );
}
