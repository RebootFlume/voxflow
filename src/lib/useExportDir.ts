import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "@/stores/app";

/**
 * 共享导出目录 hook：本地即时编辑 + 同步回 store（触发持久化）。
 * ASR 转写与 TTS 合成共用同一份导出目录，避免各自维护一份、互相借用。
 */
export function useExportDir() {
  const saved = useAppStore((s) => s.io.exportDir);
  const [dir, setDir] = useState(saved || "");

  useEffect(() => {
    if (saved && !dir) setDir(saved);
  }, [saved]);

  const setExportDir = useCallback((v: string) => {
    setDir(v);
    useAppStore.getState().updateIo({ exportDir: v });
  }, []);

  return { exportDir: dir, setExportDir };
}
