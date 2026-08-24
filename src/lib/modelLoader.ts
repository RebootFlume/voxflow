/**
 * 模型加载统一入口 —— 状态链路的「单一真源」。
 *
 * 设计原则：无论从哪个 UI 发起加载（ASR 面板 / TTS 面板 / 模型管理页），
 * 都必须调用这里，统一完成：
 *   1. 乐观置为 loading（立即反馈，不等事件回传）
 *   2. 调用 Rust 加载
 *   3. 按结果回写 ready / error（并记日志）
 *
 * 这样状态源只有一个写入路径，不会出现各调用方漏写 / 写法不一致
 * 导致的「改了不生效」。
 */
import { useAppStore } from "@/stores/app";
import { rustLoadAsrModel, rustLoadTtsModel } from "@/lib/tauri";

/** 加载 ASR 模型（model + device 一并写入，统一置 loading） */
export function loadAsrModel(name: string, device: string): Promise<void> {
  const s = useAppStore.getState();
  s.updateAsr({ model: name, device, modelStatus: "loading" });
  return rustLoadAsrModel(name, device).then(
    () => useAppStore.getState().updateAsr({ modelStatus: "ready" }),
    (e) => {
      const st = useAppStore.getState();
      st.updateAsr({ modelStatus: "error" });
      st.addLog(`[model] ASR 加载失败: ${String(e)}`, "error");
    },
  );
}

/** 加载 TTS 模型（model + device 一并写入，统一置 loading） */
export function loadTtsModel(name: string, device: string): Promise<void> {
  const s = useAppStore.getState();
  s.updateTts({ model: name, device });
  s.setTtsModelStatus("loading");
  return rustLoadTtsModel(name, device).then(
    () => useAppStore.getState().setTtsModelStatus("ready"),
    (e) => {
      const st = useAppStore.getState();
      st.setTtsModelStatus("error");
      st.addLog(`[model] TTS 加载失败: ${String(e)}`, "error");
    },
  );
}
