import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, AudioWaveform, Loader2, Sparkles, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";
import { stageLabelKey, stageProgress } from "@/lib/modelStages";

/**
 * 启动 Splash（Voicebox 式启动界面）。
 *
 * 显示条件：startupPhase === "booting"
 *
 * 消失条件（满足任一）：
 *   1. ASR 引擎就绪（ready）→ 淡出
 *   2. 启动失败（error）→ 不静默淡出，就地给出原因与出口（见下方 error 面板）
 *   3. 本次没有模型要加载（autoLoadState = none）→ 一闪而过（~0.3s）
 *   4. 开了自动加载但选中的模型没下载（autoLoadState = skipped）→ 显示「未检测到模型」1.5s 后淡出
 *   5. 10s 兜底：清单始终没到（sidecar 异常）或引擎仍在 idle → 放行，不挂死启动页
 *   6. 用户点「跳过」（10s 后按钮出现）
 *
 * 判定为什么不用固定死线：以前是"2s 内引擎还 idle 就当空启动"，那是在和自动加载赛跑 ——
 * 自动加载开关关着时必然误报「未检测到模型」（模型其实已下载且已选中），还要多等 3.5s 才进主界面。
 * 现在改成状态驱动：判定结论由 autoLoadFromManifest 写进 store（models.autoLoadState），
 * 启动页只读这个结论，不用自己猜"加载到底发生没有"。
 *
 * 加载过程可见：阶段文案与进度条与全局加载遮罩共用同一套四段（unload → loading → initializing → ready），
 * 启动期 ModelLoadingOverlay 不再同时显示（启动页已展示同一套进度，避免启动页淡出瞬间闪黑块）。
 *
 * 设计：
 *  - 全屏 fixed，z-[110]
 *  - 紫色主题品牌画面：logo + 转圈 + 阶段文案 + 进度条
 *  - 淡出动画 300ms 后 unmount
 */
export function StartupSplash() {
  const locale = useAppStore((s) => s.locale);
  const phase = useAppStore((s) => s.startupPhase);
  const asrStatus = useAppStore((s) => s.engines.asr.status);
  const asrModel = useAppStore((s) => s.engines.asr.model);
  const asrStage = useAppStore((s) => s.engines.asr.stage);
  const asrError = useAppStore((s) => s.engines.asr.error);
  const autoLoadState = useAppStore((s) => s.autoLoadState);
  // 配置恢复后才知道"本次到底要不要加载模型"
  const configLoaded = useAppStore((s) => s.configLoaded);
  const asrAutoLoad = useAppStore((s) => s.asr.autoLoad);
  const ttsAutoLoad = useAppStore((s) => s.tts.autoLoad);
  // 注意：这里要的是"配置里选中的模型"（asr.model / tts.model），不是引擎状态里的模型（engines.asr.model）——
  // 后者要等引擎真的起来才有值，启动那一刻恒为空；拿它判断会把"要加载"误判成"没东西可加载"，启动页就一闪而过了。
  const selectedAsrModel = useAppStore((s) => s.asr.model);
  const selectedTtsModel = useAppStore((s) => s.tts.model);
  // 本次启动到底要不要加载模型：任一引擎"开了自动加载且选了模型"才算要加载
  const nothingToLoad =
    configLoaded && !(asrAutoLoad && selectedAsrModel) && !(ttsAutoLoad && selectedTtsModel);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const setActiveSubMenu = useAppStore((s) => s.setActiveSubMenu);

  const [visible, setVisible] = useState(true);
  const [showSkip, setShowSkip] = useState(false);
  const [fading, setFading] = useState(false);
  const [emptyBoot, setEmptyBoot] = useState(false);
  const skipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 延迟 delayMs 后淡出 → 300ms 淡出动画结束后卸载并切到主界面 */
  const fadeOut = useCallback((delayMs = 0) => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    fadeTimer.current = setTimeout(() => {
      setFading(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => {
        setVisible(false);
        useAppStore.getState().setStartupPhase("ready");
      }, 300);
    }, delayMs);
  }, []);

  // 10s 后显示「跳过」按钮
  useEffect(() => {
    skipTimer.current = setTimeout(() => setShowSkip(true), 10_000);
    return () => {
      if (skipTimer.current) clearTimeout(skipTimer.current);
    };
  }, []);

  // 启动判定（状态驱动）：读 autoLoadState 的结论，不自己猜"加载有没有发生"
  useEffect(() => {
    if (autoLoadState === "none") {
      // 本次没有模型要加载（自动加载开关关 / 没选模型）→ 一闪而过，不让启动页拖住用户
      fadeOut(0);
      return;
    }
    if (autoLoadState === "skipped") {
      // 开了自动加载但选中的模型没下载（被删/换机）→ 这才是真的"未检测到模型"
      setEmptyBoot(true);
      return;
    }
    // 配置已恢复且确认"本次没有任何模型要加载" → 不用等清单，直接一闪而过
    if (nothingToLoad) fadeOut(0);
  }, [autoLoadState, nothingToLoad, fadeOut]);

  // 空启动：显示「未检测到模型」1.5s 后自动淡出进主界面
  useEffect(() => {
    if (!emptyBoot) return;
    fadeOut(1_500);
  }, [emptyBoot, fadeOut]);

  // 消失条件：ASR ready → 淡出；ASR error → 不静默消失，改为就地解释（见下方 error 面板）
  useEffect(() => {
    if (asrStatus === "ready") fadeOut(0);
  }, [asrStatus, fadeOut]);

  // 兜底：10s 还没拿到清单（sidecar 异常），或引擎仍在 idle（自动加载没发生）→ 放行，不挂死启动页
  useEffect(() => {
    const timer = setTimeout(() => {
      const st = useAppStore.getState();
      if (st.models.manifestAt === null) fadeOut(0);
      else if (st.engines.asr.status === "idle") fadeOut(0);
    }, 10_000);
    return () => clearTimeout(timer);
  }, [fadeOut]);

  // 用户跳过：直接淡出
  const handleSkip = () => fadeOut(0);

  if (phase !== "booting" || !visible) return null;

  // 阶段文案：初始化 → 加载中（细粒度阶段） / 已就绪（淡出前别倒退成"正在初始化…"） / 空启动
  const isAsrLoading = asrStatus === "loading";
  const stageLabel = isAsrLoading
    ? asrModel
      ? `${asrModel} · ${t(locale, stageLabelKey(asrStage))}`
      : t(locale, "splash.loading")
    : asrStatus === "ready" && asrModel
      ? `${asrModel} · ${t(locale, "overlay.stage.ready")}`
      : t(locale, "splash.init");
  const stageValue = stageProgress(asrStage);

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

      {/* 启动失败：给出原因与出口（此前静默淡出，用户不知道发生了什么） */}
      {asrStatus === "error" ? (
        <div className="mt-10 flex max-w-[420px] flex-col items-center gap-3 px-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 ring-1 ring-destructive/30">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <p className="text-sm font-medium text-foreground">{t(locale, "splash.error.title")}</p>
          {asrError && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-center text-xs leading-snug text-destructive">
              {asrError}
            </p>
          )}
          <div className="mt-1 flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                setActiveModule("models");
                setActiveSubMenu("framework");
                handleSkip();
              }}
            >
              {t(locale, "splash.error.cta")}
            </Button>
            <Button size="sm" variant="outline" onClick={handleSkip}>
              {t(locale, "splash.error.enter")}
            </Button>
          </div>
        </div>
      ) : emptyBoot ? (
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
          {isAsrLoading && (
            <div className="w-[260px]">
              <Progress value={stageValue} className="h-1.5" />
            </div>
          )}
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
