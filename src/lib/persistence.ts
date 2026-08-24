import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type HistoryRecord } from "@/stores/app";

// ---- 基础文件 I/O ----

export async function loadData(filename: string): Promise<string | null> {
  return invoke<string | null>("read_data_file", { filename });
}

export async function saveData(filename: string, content: string): Promise<void> {
  await invoke("write_data_file", { filename, content });
}

// ---- 防抖写入 ----
const pending = new Map<string, string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function debouncedSave(filename: string, content: string) {
  pending.set(filename, content);
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 300);
}

function flush() {
  for (const [filename, content] of pending) {
    void saveData(filename, content);
  }
  pending.clear();
  flushTimer = null;
}

// ---- 需要持久化的字段 ----

function extractPersistable(state: ReturnType<typeof useAppStore.getState>) {
  return {
    asr: { hotkey: state.asr.hotkey, model: state.asr.model, device: state.asr.device },
    transcribe: { format: state.transcribe.format },
    io: { exportDir: state.io.exportDir },
    tts: state.tts,
    api: { host: state.api.host, port: state.api.port, apiKey: state.api.apiKey },
    overlay: state.overlay,
    theme: state.theme,
    locale: state.locale,
    models: { modelRoot: state.models.modelRoot, mirror: state.models.mirror, proxy: state.models.proxy },
    useRustEngine: state.useRustEngine,
  };
}

// ---- config.json ----

export async function loadConfig() {
  try {
    const data = await loadData("config.json");
    if (!data) return;
    const parsed = JSON.parse(data);
    const store = useAppStore.getState();
    // 旧版本 config.json 把导出目录存在 transcribe.exportDir，迁移到 io.exportDir
    const legacyExportDir = parsed.transcribe?.exportDir;
    useAppStore.setState({
      asr: { ...store.asr, ...parsed.asr },
      tts: { ...store.tts, ...parsed.tts },
      api: { ...store.api, ...parsed.api },
      overlay: { ...store.overlay, ...parsed.overlay },
      theme: { ...store.theme, ...parsed.theme },
      locale: parsed.locale ?? store.locale,
      transcribe: { ...store.transcribe, format: parsed.transcribe?.format ?? store.transcribe.format },
      io: { exportDir: parsed.io?.exportDir ?? legacyExportDir ?? store.io.exportDir },
      models: {
        ...store.models,
        modelRoot: parsed.models?.modelRoot ?? store.models.modelRoot,
        mirror: parsed.models?.mirror ?? store.models.mirror,
        proxy: parsed.models?.proxy ?? store.models.proxy,
      },
      useRustEngine: parsed.useRustEngine ?? false,
    });
  } catch {}
}

export function saveConfigDebounced() {
  const state = useAppStore.getState();
  debouncedSave("config.json", JSON.stringify(extractPersistable(state)));
}

// ---- history/YYYY-MM-DD.json ----

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function historyFile(date: string): string {
  return `history/${date}.json`;
}

/** 加载所有历史记录文件（按日期分文件） */
export async function loadAllHistory() {
  try {
    const listData = await loadData("history/index.json");
    const dates: string[] = listData ? JSON.parse(listData) : [];
    if (dates.length === 0) return;

    const allRecords: HistoryRecord[] = [];
    for (const date of dates) {
      const data = await loadData(historyFile(date));
      if (data) {
        const records = JSON.parse(data);
        if (Array.isArray(records)) allRecords.push(...records);
      }
    }
    allRecords.sort((a, b) => b.id - a.id); // 最新的在前
    useAppStore.setState({ history: { records: allRecords.slice(0, 500) } });
  } catch {}
}

/** 保存当天的记录到文件 */
export function saveHistoryForToday(records: HistoryRecord[]) {
  const today = todayKey();
  // 只保存今天的记录
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayRecords = records.filter((r) => r.id >= todayStart.getTime());

  debouncedSave(historyFile(today), JSON.stringify(todayRecords));

  // 更新索引（去重 + 排序）
  updateHistoryIndex(today);
}

async function updateHistoryIndex(currentDate: string) {
  try {
    const listData = await loadData("history/index.json");
    const dates: string[] = listData ? JSON.parse(listData) : [];
    if (!dates.includes(currentDate)) {
      dates.push(currentDate);
      dates.sort();
      debouncedSave("history/index.json", JSON.stringify(dates));
    }
  } catch {}
}

// ---- 初始化：启动时加载 + 监听变化 ----

export async function initPersistence() {
  await loadConfig();
  await loadAllHistory();

  // 监听 store 变化 → 写 config.json
  useAppStore.subscribe((state, prev) => {
    const curr = JSON.stringify(extractPersistable(state));
    const prv = JSON.stringify(extractPersistable(prev));
    if (curr !== prv) saveConfigDebounced();
  });

  // 监听历史变化 → 按天写文件
  useAppStore.subscribe((state, prev) => {
    if (state.history.records !== prev.history.records) {
      saveHistoryForToday(state.history.records);
    }
  });
}
