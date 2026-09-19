//! 克隆音色库（Voicebox 式：录音/上传 → 命名 + 说明 → 存为条目 → 点击即用）
//!
//! 存储：`<data_root>/tts-voices/`
//! - `voices.json`：索引（条目元数据 + 当前选中 id）
//! - `<id>.<ext>`：音频文件（**文件名 = 条目 id**）
//!
//! 设计要点：
//! - 索引只存**相对文件名**（`file`）⇒ 便携版整体搬目录后仍然有效（区别于持久化绝对路径）。
//! - 写索引原子（tmp + rename），不产生半截 JSON。
//! - 与 Tauri 运行时解耦（目录由调用方传入）⇒ 可单测。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 音色库目录名（数据根下）与索引文件名
pub const DIR_NAME: &str = "tts-voices";
pub const INDEX_FILE: &str = "voices.json";

/// 认可的音频扩展名（上传按源扩展保留；不认可的一律按 wav 处理）
const AUDIO_EXTS: [&str; 5] = ["wav", "mp3", "flac", "ogg", "m4a"];

/// 一个保存下来的音色条目
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Voice {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub reference_text: String,
    /// 音频文件名（相对音色库目录）
    pub file: String,
    pub created_ms: u64,
}

/// 音色库索引
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Library {
    #[serde(default)]
    pub voices: Vec<Voice>,
    #[serde(default)]
    pub active_id: Option<String>,
}

/// 读取索引（缺失/损坏 → 空库：宁可让用户看到空列表，也不因坏文件起不来）
pub fn load(dir: &Path) -> Library {
    std::fs::read_to_string(dir.join(INDEX_FILE))
        .ok()
        .and_then(|s| serde_json::from_str::<Library>(&s).ok())
        .unwrap_or_default()
}

/// 原子写索引（tmp + rename）
pub fn save(dir: &Path, lib: &Library) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建音色库目录失败: {e}"))?;
    let text = serde_json::to_string_pretty(lib).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{INDEX_FILE}.tmp"));
    std::fs::write(&tmp, text).map_err(|e| format!("写入音色库索引失败: {e}"))?;
    std::fs::rename(&tmp, dir.join(INDEX_FILE)).map_err(|e| format!("提交音色库索引失败: {e}"))
}

/// 条目音频的绝对路径
pub fn path_of(dir: &Path, voice: &Voice) -> PathBuf {
    dir.join(&voice.file)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn ext_of(src: &Path) -> String {
    src.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| AUDIO_EXTS.contains(&e.as_str()))
        .unwrap_or_else(|| "wav".to_string())
}

/// 收进音色库：把 `source`（录音草稿或用户上传的文件）移入库内并落一条索引。
///
/// 名称必填（"保存才进库、才有名字"是这套流程的地基）。
pub fn add(
    dir: &Path,
    source: &Path,
    name: &str,
    note: &str,
    reference_text: &str,
) -> Result<Voice, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("音色名称不能为空".to_string());
    }
    if !source.is_file() {
        return Err(format!("音频文件不存在: {}", source.display()));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("创建音色库目录失败: {e}"))?;

    let ext = ext_of(source);
    let base = now_ms();
    let mut seq = 0u32;
    let (id, file) = loop {
        let id = if seq == 0 {
            format!("v-{base}")
        } else {
            format!("v-{base}-{seq}")
        };
        let file = format!("{id}.{ext}");
        if !dir.join(&file).exists() {
            break (id, file);
        }
        seq += 1;
    };

    let dest = dir.join(&file);
    if std::fs::rename(source, &dest).is_err() {
        // 跨卷 rename 失败 → 复制后删源
        std::fs::copy(source, &dest).map_err(|e| format!("收进音色库失败: {e}"))?;
        let _ = std::fs::remove_file(source);
    }

    let voice = Voice {
        id,
        name: name.to_string(),
        note: note.trim().to_string(),
        reference_text: reference_text.trim().to_string(),
        file,
        created_ms: now_ms(),
    };
    let mut lib = load(dir);
    lib.voices.push(voice.clone());
    save(dir, &lib)?;
    prune_orphans(dir, &lib);
    Ok(voice)
}

/// 改名 / 改说明 / 改参考文本
pub fn update(
    dir: &Path,
    id: &str,
    name: &str,
    note: &str,
    reference_text: &str,
) -> Result<Voice, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("音色名称不能为空".to_string());
    }
    let mut lib = load(dir);
    let voice = lib
        .voices
        .iter_mut()
        .find(|v| v.id == id)
        .ok_or_else(|| format!("音色不存在: {id}"))?;
    voice.name = name.to_string();
    voice.note = note.trim().to_string();
    voice.reference_text = reference_text.trim().to_string();
    let out = voice.clone();
    save(dir, &lib)?;
    Ok(out)
}

/// 删除条目（连带音频文件；若删的正是当前选中，一并清空 active）
pub fn remove(dir: &Path, id: &str) -> Result<(), String> {
    let mut lib = load(dir);
    let idx = lib
        .voices
        .iter()
        .position(|v| v.id == id)
        .ok_or_else(|| format!("音色不存在: {id}"))?;
    let voice = lib.voices.remove(idx);
    let _ = std::fs::remove_file(path_of(dir, &voice));
    if lib.active_id.as_deref() == Some(id) {
        lib.active_id = None;
    }
    save(dir, &lib)
}

/// 记为当前选中并返回该条目。
///
/// **调用方必须先把参数成功下发给引擎**，再调本函数 —— 否则库里显示"已选中"而引擎
/// 里根本没有这份克隆参数（谎报）。
pub fn set_active(dir: &Path, id: &str) -> Result<Voice, String> {
    let mut lib = load(dir);
    let voice = lib
        .voices
        .iter()
        .find(|v| v.id == id)
        .cloned()
        .ok_or_else(|| format!("音色不存在: {id}"))?;
    lib.active_id = Some(id.to_string());
    save(dir, &lib)?;
    Ok(voice)
}

/// 取消"当前选中"（引擎侧已 clear 克隆后调用）。
///
/// 必须与引擎同步清除：否则下次 TTS 模型就绪时按 `active_id` 恢复，
/// 会把用户刚取消的克隆**又装回来**。
pub fn clear_active(dir: &Path) -> Result<(), String> {
    let mut lib = load(dir);
    if lib.active_id.is_none() {
        return Ok(());
    }
    lib.active_id = None;
    save(dir, &lib)
}

/// 当前选中条目（无则 None）
pub fn active(dir: &Path) -> Option<Voice> {
    let lib = load(dir);
    let id = lib.active_id?;
    lib.voices.into_iter().find(|v| v.id == id)
}

/// 删除索引未引用的库内音频（孤儿：录了但没保存、或保存前进程被杀）。
/// `ref-*.wav` 是未入库的录音草稿，由 `reference_audio::prune` 按数量上限管理，这里不动。
pub fn prune_orphans(dir: &Path, lib: &Library) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for path in entries.flatten().map(|e| e.path()) {
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
            continue;
        };
        let looks_like_library_file = name.starts_with("v-")
            && AUDIO_EXTS.iter().any(|e| name.ends_with(&format!(".{e}")));
        if looks_like_library_file && !lib.voices.iter().any(|v| v.file == name) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("voxflow_voices_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn src(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, b"RIFFfake").unwrap();
        p
    }

    #[test]
    fn add_moves_file_and_persists() {
        let dir = tmp("add");
        let s = src(&dir, "ref-1.wav");
        let v = add(&dir, &s, "  小明  ", " 参考自录音 ", " 你好世界 ").unwrap();
        assert_eq!(v.name, "小明");
        assert_eq!(v.note, "参考自录音");
        assert_eq!(v.reference_text, "你好世界");
        assert!(path_of(&dir, &v).is_file(), "音频应已入库");
        assert!(!s.exists(), "草稿应被移走");
        // 重新读索引（模拟重启）
        let lib = load(&dir);
        assert_eq!(lib.voices.len(), 1);
        assert_eq!(lib.voices[0].id, v.id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_requires_name_and_existing_source() {
        let dir = tmp("valid");
        let s = src(&dir, "ref-2.wav");
        assert!(add(&dir, &s, "   ", "", "").is_err(), "空名称必须拒绝");
        assert!(add(&dir, &dir.join("nope.wav"), "名字", "", "").is_err());
        assert!(load(&dir).voices.is_empty(), "失败不得留下条目");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_rename_and_text() {
        let dir = tmp("update");
        let s = src(&dir, "a.wav");
        let v = add(&dir, &s, "旧名", "", "旧文本").unwrap();
        let u = update(&dir, &v.id, "新名", "备注", "新文本").unwrap();
        assert_eq!((u.name.as_str(), u.note.as_str(), u.reference_text.as_str()), ("新名", "备注", "新文本"));
        assert_eq!(load(&dir).voices[0].name, "新名");
        assert!(update(&dir, "不存在", "x", "", "").is_err());
        assert!(update(&dir, &v.id, "  ", "", "").is_err(), "空名称必须拒绝");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_active_then_remove_clears_active_and_file() {
        let dir = tmp("active");
        let a = add(&dir, &src(&dir, "a.wav"), "A", "", "").unwrap();
        let b = add(&dir, &src(&dir, "b.wav"), "B", "", "").unwrap();
        set_active(&dir, &a.id).unwrap();
        assert_eq!(active(&dir).unwrap().id, a.id);
        set_active(&dir, &b.id).unwrap();
        assert_eq!(active(&dir).unwrap().id, b.id);
        remove(&dir, &b.id).unwrap();
        assert!(active(&dir).is_none(), "删掉选中项必须清空 active（否则恢复时会指空）");
        assert!(!path_of(&dir, &b).exists());
        assert_eq!(load(&dir).voices.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_active_prevents_resurrecting_a_cancelled_clone() {
        let dir = tmp("clear_active");
        let v = add(&dir, &src(&dir, "a.wav"), "A", "", "文本").unwrap();
        set_active(&dir, &v.id).unwrap();
        assert!(active(&dir).is_some());
        clear_active(&dir).unwrap();
        // 就绪恢复读的是 active_id ⇒ 这里必须为空，否则取消过的克隆会被装回来
        assert!(active(&dir).is_none());
        assert!(load(&dir).active_id.is_none());
        // 幂等：重复清除不报错
        clear_active(&dir).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_removes_only_unreferenced_library_files() {
        let dir = tmp("prune");
        let keep = add(&dir, &src(&dir, "a.wav"), "A", "", "").unwrap();
        // 孤儿：入库失败/未保存留下的库内文件
        std::fs::write(dir.join("v-999.wav"), b"x").unwrap();
        // 录音草稿与用户手工文件：都不该动
        std::fs::write(dir.join("ref-123.wav"), b"x").unwrap();
        std::fs::write(dir.join("my-voice.mp3"), b"x").unwrap();

        prune_orphans(&dir, &load(&dir));

        assert!(path_of(&dir, &keep).is_file());
        assert!(!dir.join("v-999.wav").exists());
        assert!(dir.join("ref-123.wav").is_file());
        assert!(dir.join("my-voice.mp3").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_tolerates_corrupt_index() {
        let dir = tmp("corrupt");
        std::fs::write(dir.join(INDEX_FILE), b"{ not json").unwrap();
        let lib = load(&dir);
        assert!(lib.voices.is_empty() && lib.active_id.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
