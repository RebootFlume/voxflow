//! 共享：泛型引擎槽（引擎表 + 互斥路由 + active 查询）
//!
//! `AsrRegistry`（P3 套用）与未来 `TtsRegistry`（P2）各自持有一个 `EngineSlot<T>`，
//! 互斥、active 查询等通用逻辑收敛在这里，避免两域各写一份。
//! 不依赖任何具体域 trait：通过 `SlotEngine` 最小接口接入。

use std::sync::Arc;

/// 槽内引擎需要满足的最小生命周期接口。
/// 两域 trait（AsrEngine / TtsEngine）通过 blanket impl 自动满足，无需手动适配。
pub trait SlotEngine: Send + Sync {
    /// 是否已加载（可服务）
    fn slot_loaded(&self) -> bool;
    /// 卸载（释放引擎）
    fn slot_unload(&self) -> Result<(), String>;
    /// 当前已加载模型名（空 = 未加载）
    fn slot_model(&self) -> String;
}

impl SlotEngine for dyn crate::inference::engine::AsrEngine {
    fn slot_loaded(&self) -> bool {
        self.is_loaded()
    }
    fn slot_unload(&self) -> Result<(), String> {
        self.unload()
    }
    fn slot_model(&self) -> String {
        self.current_model()
    }
}

/// 引擎表：框架标识 → 引擎实例
pub struct EngineSlot<T: ?Sized + Send + Sync> {
    entries: Vec<(&'static str, Arc<T>)>,
}

impl<T: ?Sized + Send + Sync> EngineSlot<T> {
    pub fn new(entries: Vec<(&'static str, Arc<T>)>) -> Self {
        Self { entries }
    }

    /// 按框架标识取引擎
    pub fn engine(&self, framework: &str) -> Option<Arc<T>> {
        self.entries
            .iter()
            .find(|(f, _)| *f == framework)
            .map(|(_, e)| e.clone())
    }

    /// 已注册框架标识列表
    pub fn frameworks(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.entries.iter().map(|(f, _)| *f)
    }
}

impl<T: ?Sized + SlotEngine> EngineSlot<T> {
    /// 当前已加载的引擎（互斥保证有且至多一个）
    pub fn active(&self) -> Option<(&'static str, Arc<T>)> {
        self.entries
            .iter()
            .find(|(_, e)| e.slot_loaded())
            .map(|(f, e)| (*f, e.clone()))
    }

    /// 卸载除 `keep` 之外的所有已加载引擎（互斥）。
    /// 每个受害者在**卸载前**回调，供加载阶段事件（`unload:<model>`）按原时序上报。
    pub fn unload_others_with(&self, keep: &str, on_victim: &mut dyn FnMut(&'static str, &str)) {
        for (f, e) in &self.entries {
            if *f != keep && e.slot_loaded() {
                let model = e.slot_model();
                on_victim(*f, &model);
                let _ = e.slot_unload();
            }
        }
    }

    /// 卸载除 `keep` 之外的所有已加载引擎（互斥）。
    /// 返回被卸载的 (框架, 模型名)，供日志使用。
    pub fn unload_others(&self, keep: &str) -> Vec<(&'static str, String)> {
        let mut victims = Vec::new();
        self.unload_others_with(keep, &mut |f, m| victims.push((f, m.to_string())));
        victims
    }
}

/// 加载失败后的回滚决策（纯函数，单测锁）：`prev` = 加载前正在服务的 (框架, 模型名)。
///
/// 返回需要装回来的模型；无需回滚 → None。两种无需回滚的情形：
/// - 加载前没有任何模型（无旧可回）
/// - 目标与旧模型同名（引擎层负责替换自己，失败即无旧可回）
pub fn rollback_target(
    prev: Option<(&'static str, String)>,
    target: &str,
) -> Option<(&'static str, String)> {
    let (framework, model) = prev?;
    (!model.is_empty() && model != target).then_some((framework, model))
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    #[test]
    fn test_rollback_target() {
        // 有旧模型且与目标不同 → 回滚到旧模型
        let prev = Some(("gguf", "Qwen3-ASR-0.6B".to_string()));
        assert_eq!(
            rollback_target(prev.clone(), "Qwen3-ASR-1.7B"),
            Some(("gguf", "Qwen3-ASR-0.6B".to_string()))
        );
        // 目标与旧同名 → 不回滚（引擎层替换自己）
        assert_eq!(rollback_target(prev.clone(), "Qwen3-ASR-0.6B"), None);
        // 没有旧模型 / 旧模型名为空 → 不回滚
        assert_eq!(rollback_target(None, "x"), None);
        assert_eq!(rollback_target(Some(("gguf", String::new())), "x"), None);
    }

    struct MockEngine {
        loaded: Mutex<bool>,
        model: Mutex<String>,
    }

    impl MockEngine {
        fn new(model: &str) -> Arc<Self> {
            Arc::new(Self {
                loaded: Mutex::new(false),
                model: Mutex::new(model.to_string()),
            })
        }
    }

    impl SlotEngine for MockEngine {
        fn slot_loaded(&self) -> bool {
            *self.loaded.lock()
        }
        fn slot_unload(&self) -> Result<(), String> {
            *self.loaded.lock() = false;
            Ok(())
        }
        fn slot_model(&self) -> String {
            self.model.lock().clone()
        }
    }

    #[test]
    fn test_engine_lookup() {
        let a = MockEngine::new("model-a");
        let slot: EngineSlot<MockEngine> = EngineSlot::new(vec![("aa", a)]);
        assert!(slot.engine("aa").is_some());
        assert!(slot.engine("bb").is_none());
        assert_eq!(slot.frameworks().collect::<Vec<_>>(), vec!["aa"]);
    }

    #[test]
    fn test_active_requires_loaded() {
        let a = MockEngine::new("model-a");
        let slot: EngineSlot<MockEngine> = EngineSlot::new(vec![("aa", a.clone())]);
        assert!(slot.active().is_none());
        *a.loaded.lock() = true;
        let (fw, _) = slot.active().unwrap();
        assert_eq!(fw, "aa");
    }

    #[test]
    fn test_unload_others_keeps_target_and_reports_victims() {
        let a = MockEngine::new("model-a");
        let b = MockEngine::new("model-b");
        *a.loaded.lock() = true;
        *b.loaded.lock() = true;
        let slot: EngineSlot<MockEngine> = EngineSlot::new(vec![("aa", a.clone()), ("bb", b.clone())]);
        let victims = slot.unload_others("bb");
        // 只卸 aa，保 bb
        assert_eq!(victims, vec![("aa", "model-a".to_string())]);
        assert!(!*a.loaded.lock());
        assert!(*b.loaded.lock());
    }
}
