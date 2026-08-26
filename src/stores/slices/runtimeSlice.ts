import type { HistoryRecord, RuntimeLog, RuntimeLogLevel } from "../types";

let NEXT_LOG_ID = 1;
const nowTs = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};

export interface RuntimeSlice {
  runtimeLogs: RuntimeLog[];
  history: { records: HistoryRecord[] };
  addLog: (msg: string, level?: RuntimeLogLevel) => void;
  clearLogs: () => void;
  addHistoryRecord: (text: string) => void;
  removeHistoryRecord: (id: number) => void;
}

export const createRuntimeSlice = (set: (partial: Partial<RuntimeSlice> | ((s: RuntimeSlice) => Partial<RuntimeSlice>)) => void): RuntimeSlice => ({
  runtimeLogs: [],
  history: { records: [] },
  addLog: (msg, level = "info") =>
    set((s) => {
      const next = [...s.runtimeLogs, { id: NEXT_LOG_ID++, ts: nowTs(), level, msg }];
      return { runtimeLogs: next.length > 300 ? next.slice(-300) : next };
    }),
  clearLogs: () => set({ runtimeLogs: [] }),
  addHistoryRecord: (text) =>
    set((s) => ({
      history: {
        ...s.history,
        records: [...s.history.records, { id: Date.now(), text, time: new Date().toLocaleString() }].slice(-500),
      },
    })),
  removeHistoryRecord: (id) =>
    set((s) => ({ history: { ...s.history, records: s.history.records.filter((r) => r.id !== id) } })),
});
