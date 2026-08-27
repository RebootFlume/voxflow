import { useEffect, useRef, useState } from "react";
import { AudioWaveform, Loader2, Sparkles, Download } from "lucide-react";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";

/**
 * 启动 Splash（Voicebox 式启动界面）。
 *
 * 显示条件：startupPhase === "booting"
 * 消失条件（满足任一）：
 *   1. ASR 引擎就绪（ready）或加载失败（error）→ 淡出
 *   2. 用户点击「跳过」（10s 后按钮出现）
 *   3. 空启动：2s 内 ASR 仍 idle（无模型要加载）→ 显示「未检测到模型」并淡出，引导去模型页
 *
 * 设计：
 *  - 全屏 fixed，z-[110]（盖在 ModelLoadingOverlay 之上）
 *  - 紫色主题品牌画面：logo + 转圈 + 阶段文案 + 版本
 *  - 淡出动画 400ms 后 unmount
 */
export function StartupSplash() {
  const locale = useAppStore((s) => s.locale);
  const phase = useAppStore((s) => s.startupPhase);
  const asrStatus = useAppStore((s) => s.engines.asr.status);
  const asrModel = useAppStore((s) => s.engines.asr.model);
  const asrStage = useAppStore((s) => s.engines.asr.stage);

  const [visible, setVisible] = useState(true);
  const [showSkip, setShowSkip] = useState(false);
  const [fading, setFading] = useState(false);
  const [emptyBoot, setEmptyBoot] = useState(false);
  const skipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emptyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 10s 后显示「跳过」按钮
  useEffect(() => {
    skipTimer.current = setTimeout(() => setShowSkip(true), 10_000);
    return () => {
      if (skipTimer.current) clearTimeout(skipTimer.current);
    };
  }, []);

  // 空启动检测：2s 后若 ASR 仍未进入 loading（没有模型被触发加载）→ 视为空启动
  useEffect(() => {
    emptyTimer.current = setTimeout(() => {
      const st = useAppStore.getState();
      if (st.engines.asr.status === "idle") {
        setEmptyBoot(true);
      }
    }, 2_000);
    return () => {
      if (emptyTimer.current) clearTimeout(emptyTimer.current);
    };
  }, []);

  // 空启动：显示「未检测到模型」1.5s 后自动淡出进主界面
  useEffect(() => {
    if (!emptyBoot) return;
    fadeTimer.current = setTimeout(() => {
      setVisible(false);
      useAppStore.getState().setStartupPhase("ready");
    }, 1_500);
    return () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    };
  }, [emptyBoot]);

  // 消失条件：ASR ready/error → 淡出 400ms → 置 startupPhase ready（unmount）
  useEffect(() => {
    if (asrStatus === "ready" || asrStatus === "error") {
      setFading(true);
      fadeTimer.current = setTimeout(() => {
        setVisible(false);
        useAppStore.getState().setStartupPhase("ready");
      }, 400);
    }
    return () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    };
  }, [asrStatus]);

  // 用户跳过：直接淡出
  const handleSkip = () => {
    setFading(true);
    fadeTimer.current = setTimeout(() => {
      setVisible(false);
      useAppStore.getState().setStartupPhase("ready");
    }, 300);
  };

  if (phase !== "booting" || !visible) return null;

  // 阶段文案：初始化 → 加载中（细粒度阶段） / 空启动
  const isAsrLoading = asrStatus === "loading";
  // 细粒度阶段 → 文案（框架无关，与 ModelLoadingOverlay 一致）
  const stageText: Record<string, string> = {
    unload: t(locale, "overlay.stage.unload"),
    loading: t(locale, "overlay.stage.loading"),
    initializing: t(locale, "overlay.stage.initializing"),
  };
  const stageLabel = isAsrLoading
    ? asrModel
      ? `${asrModel} · ${stageText[asrStage ?? "loading"] ?? stageText.loading}`
      : t(locale, "splash.loading")
    : t(locale, "splash.init");

  return (
    <div
      className={`fixed inset-0 z-[110] flex flex-col items-center justify-center bg-background transition-opacity duration-300 ${
        fading ? "opacity-0" : "opacity-100"
      }`}
    >
      {/* 顶部环境光（品牌氛围） */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-primary/15 to-transparent" />

      {/* Logo */}
      <div className="relative mb-8">
        <div className="absolute inset-0 -m-4 rounded-full bg-primary/20 blur-2xl" />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/30">
          <AudioWaveform className="h-10 w-10 text-primary" strokeWidth={1.8} />
        </div>
      </div>

      {/* 标题 */}
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">
        {t(locale, "splash.title")}
      </h1>
      <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        {t(locale, "splash.subtitle")}
      </p>

      {/* 加载指示：正常加载 / 空启动引导 */}
      {emptyBoot ? (
        <div className="mt-10 flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/30">
            <Download className="h-6 w-6 text-primary" />
          </div>
          <p className="max-w-[280px] text-center text-sm text-muted-foreground">
            {t(locale, "splash.noModel")}
          </p>
        </div>
      ) : (
        <div className="mt-10 flex flex-col items-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="max-w-[260px] truncate text-center text-sm text-muted-foreground">
            {stageLabel}
          </p>
        </div>
      )}

      {/* 跳过按钮（10s 后出现） */}
      <div className="absolute bottom-10 flex flex-col items-center gap-1.5">
        {showSkip && (
          <>
            <button
              onClick={handleSkip}
              className="rounded-lg border border-border bg-card px-4 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              {t(locale, "splash.skip")}
            </button>
            <p className="max-w-[300px] text-center text-[11px] text-muted-foreground/60">
              {t(locale, "splash.skipHint")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
