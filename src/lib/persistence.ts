import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type HistoryRecord } from "@/stores";

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

// ---- config.json ----

/** 读取配置文件并恢复到 store */
export async function loadConfig() {
  try {
    const data = await loadData("config.json");
    if (!data) return;
    const parsed = JSON.parse(data);
    const store = useAppStore.getState();
    useAppStore.setState({
      asr: { ...store.asr, ...parsed.asr },
      tts: { ...store.tts, ...parsed.tts },
      api: { ...store.api, ...parsed.api, endpoints: { ...store.api.endpoints, ...parsed.api?.endpoints } },
      overlay: { ...store.overlay, ...parsed.overlay },
      theme: { ...store.theme, ...parsed.theme },
      locale: parsed.locale ?? store.locale,
      io: { ...store.io, ...parsed.io },
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

/** 保存当前配置到文件 */
export async function saveConfig() {
  try {
    const state = useAppStore.getState();
    const config = {
      asr: { hotkey: state.asr.hotkey, model: state.asr.model, device: state.asr.device },
      tts: state.tts,
      api: { host: state.api.host, port: state.api.port, apiKey: state.api.apiKey },
      io: { exportDir: state.io.exportDir },
      overlay: state.overlay,
      theme: state.theme,
      locale: state.locale,
      models: { modelRoot: state.models.modelRoot, mirror: state.models.mirror, proxy: state.models.proxy },
      useRustEngine: state.useRustEngine,
    };
    await saveData("config.json", JSON.stringify(config, null, 2));
  } catch {}
}

// ---- 运行日志：logs/YYYY-MM-DD.json（每天一个文件，最近 300 条，持久化）----

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 保存运行日志到当天文件 */
export function saveRuntimeLogs(logs: unknown[]) {
  debouncedSave(`logs/${todayKey()}.json`, JSON.stringify(logs));
}

/** 加载当天运行日志 */
export async function loadRuntimeLogs() {
  try {
    const data = await loadData(`logs/${todayKey()}.json`);
    if (!data) return;
    const logs = JSON.parse(data);
    if (Array.isArray(logs)) {
      useAppStore.setState({ runtimeLogs: logs });
    }
  } catch {}
}

// ---- history/YYYY-MM-DD.json ----

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
  await loadRuntimeLogs();

  // 监听配置变化 → 防抖保存
  let configTimer: ReturnType<typeof setTimeout> | null = null;
  const watchConfigKeys = ["asr", "tts", "api", "io", "overlay", "theme", "locale", "models", "useRustEngine"] as const;
  useAppStore.subscribe((state, prev) => {
    const changed = watchConfigKeys.some((k) => state[k] !== prev[k]);
    if (changed) {
      if (configTimer) clearTimeout(configTimer);
      configTimer = setTimeout(() => saveConfig(), 500);
    }
  });

  // 监听历史变化 → 按天写文件
  useAppStore.subscribe((state, prev) => {
    if (state.history.records !== prev.history.records) {
      saveHistoryForToday(state.history.records);
    }
  });

  // 监听运行日志变化 → 写文件
  useAppStore.subscribe((state, prev) => {
    if (state.runtimeLogs !== prev.runtimeLogs) {
      saveRuntimeLogs(state.runtimeLogs);
    }
  });
}
