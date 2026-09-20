import { useEffect, useRef, useState } from "react";
import { Cpu, Download, Loader2, PackageOpen, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";
import { rustCancelRuntimeDownload, rustCheckRuntime, rustDownloadRuntime, rustPyTorchDeviceInfo, rustVerifyRuntime } from "@/lib/tauri";

interface RuntimePkg {
  framework: string;
  engine?: string;
  name: string;
  variant?: string;
  supports_cpu?: boolean;
  supports_cuda?: boolean;
  version: string;
  installed: boolean;
  state: "ready" | "incomplete" | "missing";
  missing: string[];
  dir: string;
}

/**
 * 框架行里所有小标签的统一格式（变体 / 推理能力 CPU·CUDA 共用）。
 * 之所以抽成常量：变体与能力此前一个是徽标、一个是纯文本且窄窗口会被隐藏，
 * 同一行里两套写法 —— 这里是"格式统一"的唯一出处。
 */
const FRAMEWORK_CHIP = "shrink-0 font-mono text-[10px] uppercase";

/** 推理框架（运行时 libs）管理页：下载/校验/修复 llama、sherpa、PyTorch */
export function FrameworkPanel() {
  const locale = useAppStore((s) => s.locale);
  const [packages, setPackages] = useState<RuntimePkg[] | null>(null);
  const [root, setRoot] = useState("");
  // 每框架的校验结果（null = 尚未校验）
  const [verifyResult, setVerifyResult] = useState<Record<string, { ok: boolean; msg: string } | null>>({});
  // 下载状态/错误在全局 store（常住：切页回来进度与报错都不丢）
  const dl = useAppStore((s) => s.runtimeDownload);
  const setRuntimeDownload = useAppStore((s) => s.setRuntimeDownload);
  // 正在请求取消的框架（仅用于按钮 loading/防连点；终态清理由 store 事件驱动）
  const [cancelling, setCancelling] = useState<string | null>(null);
  // PyTorch 设备探测结果（装了 CUDA 包 ≠ GPU 能用，必须问 worker 才算数）
  const [deviceInfo, setDeviceInfo] = useState<Record<string, { ok: boolean; msg: string } | null>>({});

  const refresh = () => {
    rustCheckRuntime()
      .then((r) => {
        setPackages(r.packages);
        setRoot(r.root);
      })
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 下载完成/失败（store 清空）时刷新状态；切页回来自动续显
  const prevDlFw = useRef<string | null>(null);
  useEffect(() => {
    const cur = dl.framework;
    if (prevDlFw.current !== null && cur === null) {
      refresh();
    }
    prevDlFw.current = cur;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dl.framework]);

  const doDownload = async (fw: string) => {
    setRuntimeDownload(fw, 0, null, "downloading");
    try {
      await rustDownloadRuntime(fw);
    } catch (e) {
      // 报错同时写 store（常驻显示；Rust 也会发 runtime_download_error 事件）
      setRuntimeDownload(null, 0, String(e));
    }
  };

  // 取消下载：Rust 收尾后发 runtime_download_cancelled 事件清空 store（进度条/按钮自动消失）
  const doCancel = async (fw: string) => {
    setCancelling(fw);
    try {
      await rustCancelRuntimeDownload(fw);
    } catch {
      // 取消失败（如下载已结束）：不打扰用户，状态仍由后续事件矫正
    } finally {
      setCancelling(null);
    }
  };

  // 两步验证：文件检查（缺什么列清单）+ 试启动（DLL 链能否跑）——绝不触发下载
  const doVerify = async (fw: string) => {
    setVerifyResult((v) => ({ ...v, [fw]: null }));
    try {
      const r = await rustVerifyRuntime(fw);
      if (r.state === "ready") {
        setVerifyResult((v) => ({ ...v, [fw]: { ok: true, msg: t(locale, "framework.verifyOk") } }));
      } else if (r.state === "incomplete") {
        const reason = t(locale, "framework.missingList", { files: r.missing.join(", ") });
        setVerifyResult((v) => ({ ...v, [fw]: { ok: false, msg: t(locale, "framework.verifyFail", { reason }) } }));
      } else if (r.state === "error") {
        const reason = r.error || t(locale, "framework.verifyRunFail");
        setVerifyResult((v) => ({ ...v, [fw]: { ok: false, msg: t(locale, "framework.verifyFail", { reason }) } }));
      } else {
        setVerifyResult((v) => ({ ...v, [fw]: { ok: false, msg: t(locale, "framework.notInstalled") } }));
      }
    } catch (e) {
      setVerifyResult((v) => ({ ...v, [fw]: { ok: false, msg: t(locale, "framework.verifyFail", { reason: String(e) }) } }));
    }
  };

  // PyTorch 设备探测：起 worker 问 runtime_info（真实判据，不是看包在不在）
  const doProbeDevice = async (fw: string) => {
    const device: "cpu" | "cuda" = fw === "pytorch-cuda130" ? "cuda" : "cpu";
    setDeviceInfo((v) => ({ ...v, [fw]: null }));
    try {
      const r = await rustPyTorchDeviceInfo(device);
      if (!r.ok || !r.info) {
        setDeviceInfo((v) => ({ ...v, [fw]: { ok: false, msg: r.error || t(locale, "framework.probeFail") } }));
        return;
      }
      const i = r.info;
      const msg =
        device === "cuda"
          ? i.cuda_available
            ? `${i.torch} · CUDA ${i.cuda_version ?? "?"} · ${i.device_count} device(s)`
            : `${i.torch} · ${t(locale, "framework.cudaUnavailable")}`
          : `${i.torch} · Python ${i.python}`;
      setDeviceInfo((v) => ({ ...v, [fw]: { ok: device !== "cuda" || i.cuda_available, msg } }));
    } catch (e) {
      setDeviceInfo((v) => ({ ...v, [fw]: { ok: false, msg: String(e) } }));
    }
  };

  // 框架描述文案查表；CPU/CUDA 变体由 Rust RuntimePkg 下发
  const frameworkMeta: Record<string, { descKey: string }> = {
    gguf: { descKey: "framework.desc.llama" },
    onnx: { descKey: "framework.desc.sherpa" },
    "pytorch-cpu": { descKey: "framework.desc.pytorch" },
    "pytorch-cuda130": { descKey: "framework.desc.pytorch" },
  };


  return (
    <div className="space-y-3">
      {/* 与模型列表页同一套页头（h3 + 右侧刷新图标）与行样式（rounded-lg border）：
          此前这里外层再套一张 Card，形成"方框套方框"，与模型下载页完全两种风格 */}
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <PackageOpen className="h-4 w-4 text-muted-foreground" />
          {t(locale, "framework.title")}
        </h3>
        <Button variant="ghost" size="icon" onClick={refresh} aria-label="refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t(locale, "framework.desc")}</p>

      {!packages ? (
        <div className="flex h-16 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t(locale, "framework.loading")}
        </div>
      ) : (
        <>
          {packages.map((pkg) => {
            const meta = frameworkMeta[pkg.framework] ?? { descKey: "" };
            return (
              <div key={pkg.framework} className="rounded-lg border">
                {/* 主行：状态图标 + 名称/变体/版本/状态 + 右侧动作（与模型行同构） */}
                <div className="flex items-center gap-3 px-4 py-3">
                  {pkg.state === "ready" ? (
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                      ✓
                    </span>
                  ) : pkg.state === "incomplete" ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-600 dark:text-amber-400" />
                  ) : (
                    <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    {/* 主信息单行。标签一律走同一套 chip（outline + mono + 10px + 大写）：
                        「变体」= 这一行是哪个包（cpu / cuda130），「能力」= CPU / CUDA 各一枚、按
                        supports_* 显示 —— 两者同格式、同尺寸，能力标签不再因宽度被隐藏
                        （此前能力是纯文本且 xl 才显示，等于没了）。
                        宽度不足时由说明（flex-1，省略号）先压缩，overflow-hidden 兜底，
                        避免内联长文本画到右侧按钮底下。 */}
                    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                      <span className="shrink-0 text-sm font-medium">{pkg.name}</span>
                      {pkg.variant ? (
                        <Badge variant="outline" className={FRAMEWORK_CHIP} title={pkg.variant}>
                          {pkg.variant}
                        </Badge>
                      ) : null}
                      {pkg.version ? (
                        <span
                          className="hidden shrink-0 font-mono text-[11px] text-muted-foreground lg:inline"
                          title={pkg.version}
                        >
                          {pkg.version}
                        </span>
                      ) : null}
                      {pkg.state === "ready" ? (
                        <Badge
                          variant="outline"
                          className="shrink-0 border-emerald-500/20 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400"
                        >
                          {t(locale, "framework.installed")}
                        </Badge>
                      ) : pkg.state === "incomplete" ? (
                        <Badge variant="outline" className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">
                          {t(locale, "framework.incomplete")}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">
                          {t(locale, "framework.notInstalled")}
                        </Badge>
                      )}
                      {/* 推理能力标签移到目录行（见下）：这一行在窄窗口会挤掉它们，
                          而"支持 CPU/CUDA"是必须看见的信息 */}
                      <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground lg:inline">
                        {meta.descKey ? t(locale, meta.descKey) : ""}
                      </span>
                    </div>
                    {/* 目录 + 推理能力：目录是完整路径，内联到上一行必被右侧按钮压住；
                        能力标签放这里才有空间常显（与变体同一套 chip 格式） */}
                    <div className="mt-0.5 flex min-w-0 items-center gap-2">
                      <p
                        className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70"
                        title={pkg.dir}
                      >
                        {pkg.dir}
                      </p>
                      {pkg.supports_cpu && (
                        <Badge variant="outline" className={FRAMEWORK_CHIP} title={t(locale, "framework.cap.cpu")}>
                          CPU
                        </Badge>
                      )}
                      {pkg.supports_cuda && (
                        <Badge variant="outline" className={FRAMEWORK_CHIP} title={t(locale, "framework.cap.cuda")}>
                          CUDA
                        </Badge>
                      )}
                    </div>
                    {verifyResult[pkg.framework] && (
                      <p
                        className={`mt-1 text-[11px] ${
                          verifyResult[pkg.framework]!.ok
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-destructive"
                        }`}
                      >
                        {verifyResult[pkg.framework]!.msg}
                      </p>
                    )}
                    {deviceInfo[pkg.framework] && (
                      <p
                        className={`mt-1 text-[11px] ${
                          deviceInfo[pkg.framework]!.ok
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-destructive"
                        }`}
                      >
                        {deviceInfo[pkg.framework]!.msg}
                      </p>
                    )}
                    {dl.framework === pkg.framework && (
                      <div className="mt-2 space-y-1">
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full bg-primary transition-all ${dl.phase === "extracting" ? "animate-pulse" : ""}`}
                            style={{ width: `${dl.pct}%` }}
                          />
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          {dl.phase === "extracting"
                            ? t(locale, "framework.extracting")
                            : `${t(locale, "framework.downloading")}: ${dl.pct}%`}
                        </p>
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    {pkg.state === "ready" ? (
                      <>
                        <Button size="sm" variant="outline" onClick={() => void doVerify(pkg.framework)}>
                          <RefreshCw className="mr-1 h-3.5 w-3.5" />
                          {t(locale, "framework.verify")}
                        </Button>
                        {pkg.engine === "pytorch" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void doProbeDevice(pkg.framework)}
                            disabled={deviceInfo[pkg.framework] === null}
                          >
                            <Cpu className="mr-1 h-3.5 w-3.5" />
                            {t(locale, "framework.probeDevice")}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void doDownload(pkg.framework)}
                          disabled={dl.framework !== null}
                        >
                          <Download className="mr-1 h-3.5 w-3.5" />
                          {t(locale, "framework.update")}
                        </Button>
                      </>
                    ) : pkg.state === "incomplete" ? (
                      <>
                        <Button size="sm" variant="outline" onClick={() => void doVerify(pkg.framework)}>
                          <RefreshCw className="mr-1 h-3.5 w-3.5" />
                          {t(locale, "framework.verify")}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => void doDownload(pkg.framework)}
                          disabled={dl.framework !== null}
                        >
                          <Download className="mr-1 h-3.5 w-3.5" />
                          {t(locale, "framework.repair")}
                        </Button>
                      </>
                    ) : (
                      <>
                        {/* 未安装也允许「校验」：手动放置的运行时靠它被识别，
                            否则用户只能重下（这是本次踩坑的直接原因） */}
                        <Button size="sm" variant="outline" onClick={() => void doVerify(pkg.framework)}>
                          <RefreshCw className="mr-1 h-3.5 w-3.5" />
                          {t(locale, "runtime.verify")}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => void doDownload(pkg.framework)}
                          disabled={dl.framework !== null}
                        >
                          {dl.framework === pkg.framework ? (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Download className="mr-1 h-3.5 w-3.5" />
                          )}
                          {t(locale, "framework.download")}
                        </Button>
                      </>
                    )}
                    {/* 下载中才显示取消；取消/完成/失败后 store 清空 → 按钮自动消失 */}
                    {dl.framework === pkg.framework && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void doCancel(pkg.framework)}
                        disabled={cancelling === pkg.framework}
                      >
                        {cancelling === pkg.framework ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <X className="mr-1 h-3.5 w-3.5" />
                        )}
                        {t(locale, "framework.cancel")}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          <p className="pt-1 text-[11px] text-muted-foreground/70">
            {t(locale, "framework.root", { path: root || "…" })}
          </p>
        </>
      )}
      {dl.error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t(locale, "framework.error")}: {dl.error}
        </p>
      )}
    </div>
  );
}
