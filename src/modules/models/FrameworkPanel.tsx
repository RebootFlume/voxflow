import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Cpu, Download, Loader2, RefreshCw, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

/** 推理框架（运行时 libs）管理页：下载/校验/修复 llama、sherpa，PyTorch 占位 */
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
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t(locale, "framework.title")}</CardTitle>
          <CardDescription>{t(locale, "framework.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!packages ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t(locale, "framework.loading")}
            </div>
          ) : (
            <>
              {packages.map((pkg) => {
                const meta = frameworkMeta[pkg.framework] ?? { descKey: "" };
                return (
                  <div
                    key={pkg.framework}
                    className="flex items-center gap-3 rounded-lg border p-3"
                  >
                    <div
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                        pkg.state === "ready"
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : pkg.state === "incomplete"
                            ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                            : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {pkg.state === "ready" ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : pkg.state === "incomplete" ? (
                        <Loader2 className="h-4 w-4" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{pkg.name}</span>
                        {pkg.variant ? (
                          <span className="font-mono text-[11px] text-muted-foreground" title={pkg.variant}>
                            {pkg.variant}
                          </span>
                        ) : null}
                        {pkg.version ? (
                          <span className="font-mono text-[11px] text-muted-foreground" title={pkg.version}>
                            {pkg.version}
                          </span>
                        ) : null}
                        {pkg.state === "ready" ? (
                          <Badge variant="secondary" className="text-[10px]">
                            {t(locale, "framework.installed")}
                          </Badge>
                        ) : pkg.state === "incomplete" ? (
                          <Badge variant="outline" className="text-[10px] text-amber-600 dark:text-amber-400">
                            {t(locale, "framework.incomplete")}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-amber-600 dark:text-amber-400">
                            {t(locale, "framework.notInstalled")}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {pkg.framework === "pytorch-cpu"
                          ? "PyTorch CPU runtime"
                          : pkg.framework === "pytorch-cuda130"
                            ? "PyTorch CUDA 13.0 runtime; CPU fallback supported"
                            : meta.descKey
                              ? t(locale, meta.descKey)
                              : ""}
                      </p>
                      {(pkg.supports_cpu || pkg.supports_cuda) && (
                        <p className="text-[10px] text-muted-foreground">
                          {pkg.supports_cpu ? "CPU" : ""}{pkg.supports_cpu && pkg.supports_cuda ? " · " : ""}{pkg.supports_cuda ? "CUDA" : ""}
                        </p>
                      )}
                      <p className="truncate font-mono text-[10px] text-muted-foreground/60">{pkg.dir}</p>
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
                          {/* 未安装也允许「验证」：手动放置的运行时靠它被识别，
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
                );
              })}
              <p className="pt-1 text-[11px] text-muted-foreground/70">
                {t(locale, "framework.root", { path: root || "…" })}
              </p>
            </>
          )}
        </CardContent>
      </Card>
      {dl.error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t(locale, "framework.error")}: {dl.error}
        </p>
      )}
    </div>
  );
}
