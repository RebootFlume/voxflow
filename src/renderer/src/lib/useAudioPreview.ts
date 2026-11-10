import { useCallback, useEffect, useRef, useState } from "react";
import { audioUrl } from "@/lib/ipc";

/** 模块级"当前播放"登记：多个 hook 实例之间也保证同一时刻只响一个 */
let stopCurrent: (() => void) | null = null;

/**
 * 应用内试听/回放。
 *
 * 直接喂 `<audio>` 一个 `voxflow-audio://` URL，由 Chromium 自己分块读盘。
 *
 * 为什么不再走「IPC 读全字节 → Blob」：
 *   1. 那条路有 32MB 上限（24kHz/16bit/mono ≈ 11.6 分钟）。长文本合成一段就有
 *      几百 MB，播放按钮会在最需要它的时候报「文件过大」——把合成端刚解决的
 *      内存问题又搬到了播放端。
 *   2. 整段读进渲染进程内存，长音频直接卡死渲染线程。
 *   3. Blob 没有 Range，拖进度条只能在全量加载后本地 seek。
 *
 * 代价：失败原因只剩 `audio.onerror`（没有主进程抛的具体文案），
 * 所以这里给一句能指导排查的提示，而不是一个空错误。
 */
export function useAudioPreview() {
  /** 正在播放的文件路径；空串 = 没在播 */
  const [playing, setPlaying] = useState("");
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const teardown = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    setPlaying("");
  }, []);

  const stop = useCallback(() => {
    if (stopCurrent === teardown) stopCurrent = null;
    teardown();
    setError("");
  }, [teardown]);

  useEffect(
    () => () => {
      if (stopCurrent === teardown) stopCurrent = null;
      teardown();
    },
    [teardown],
  );

  /**
   * 播放指定音频；再点同一个 = 停止，换一个则自动停掉上一个。
   *
   * 返回 `null` 表示已开始播放；否则返回失败原因字符串（调用方据此给出可见反馈）。
   */
  const play = useCallback(
    async (path: string): Promise<string | null> => {
      if (!path) return null;
      setError("");
      if (playing === path) {
        stop();
        return null;
      }
      stopCurrent?.();
      stopCurrent = teardown;
      try {
        const audio = new Audio(audioUrl(path));
        audioRef.current = audio;
        audio.onended = () => {
          if (stopCurrent === teardown) stopCurrent = null;
          teardown();
        };
        audio.onerror = () => {
          if (stopCurrent === teardown) stopCurrent = null;
          teardown();
          setError("无法播放该文件（文件可能已被移动或删除，或格式不被支持）");
        };
        await audio.play();
        setPlaying(path);
        return null;
      } catch (e) {
        if (stopCurrent === teardown) stopCurrent = null;
        teardown();
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        return msg;
      }
    },
    [playing, stop, teardown],
  );

  return { play, stop, playing, error };
}
