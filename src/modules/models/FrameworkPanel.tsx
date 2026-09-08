import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, Loader2, Lock, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";
import { rustCheckRuntime, rustDownloadRuntime, rustVerifyRuntime } from "@/lib/tauri";

interface RuntimePkg {
  framework: string;
  name: string;
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

  // 框架定义（含未来 PyTorch 占位）
  const frameworkMeta: Record<string, { descKey: string; future?: boolean }> = {
    gguf: { descKey: "framework.desc.llama" },
    onnx: { descKey: "framework.desc.sherpa" },
    pytorch: { descKey: "framework.desc.pytorch", future: true },
  };

  // PyTorch 占位卡片（未注册到 Rust，纯展示）
  const pytorchCard = (
    <Card key="pytorch" className="opacity-70">
      <CardContent className="flex items-center gap-3 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
          <Lock className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">PyTorch</span>
            <Badge variant="outline" className="text-[10px]">
              {t(locale, "framework.comingSoon")}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{t(locale, "framework.desc.pytorch")}</p>
        </div>
      </CardContent>
    </Card>
  );

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
                        {meta.descKey ? t(locale, meta.descKey) : ""}
                      </p>
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
                      )}
                    </div>
                  </div>
                );
              })}
              {pytorchCard}
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
