import { useCallback, useEffect, useRef, useState } from "react";
import { rustReadAudio } from "@/lib/tauri";

/** 扩展名 → MIME（与 Rust 侧 LISTEN_EXTS 同集合） */
const MIME: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
};

/** 模块级"当前播放"登记：多个 hook 实例之间也保证同一时刻只响一个 */
let stopCurrent: (() => void) | null = null;

/**
 * 应用内试听：读取音频字节（`rust_read_audio`）→ Blob → `<audio>` 播放。
 *
 * 不用 `openPath` 的原因见 Rust 侧注释：那条路依赖系统默认播放器 + `opener:allow-open-path` 权限，
 * 本项目没有该权限 ⇒ 点了没反应。这里在应用内放音，既能响也能给出"在播/停止"的反馈。
 */
export function useAudioPreview() {
  /** 正在播放的文件路径；空串 = 没在播 */
  const [playing, setPlaying] = useState("");
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef("");

  const teardown = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = "";
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
   * 返回 `null` 表示已开始播放；否则返回失败原因字符串（调用方据此给出可见反馈 ——
   * 试听读不到文件时必须让用户看到原因，否则又变成"点了没反应"）。
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
        const buf = await rustReadAudio(path);
        const ext = path.split(".").pop()?.toLowerCase() ?? "";
        const url = URL.createObjectURL(new Blob([buf], { type: MIME[ext] ?? "audio/wav" }));
        urlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          if (stopCurrent === teardown) stopCurrent = null;
          teardown();
        };
        audio.onerror = () => {
          if (stopCurrent === teardown) stopCurrent = null;
          teardown();
          setError("audio playback failed");
        };
        await audio.play();
        setPlaying(path);
        return null;
      } catch (e) {
        if (stopCurrent === teardown) stopCurrent = null;
        teardown();
        // Rust 侧返回的已是完整句子（"读取音频失败：…"）⇒ 不要 "Error: " 前缀
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        return msg;
      }
    },
    [playing, stop, teardown],
  );

  return { play, stop, playing, error };
}
