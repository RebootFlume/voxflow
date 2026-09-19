import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FolderOpen,
  HardDrive,
  Loader2,
  Mic,
  Power,
  RefreshCw,
  Trash2,
  Upload,
  Volume2,
  X,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAppStore, type ModelItemState } from "@/stores";
import { t } from "@/lib/i18n";
import { openPath, pickFolder, sendToSidecar } from "@/lib/tauri";
import { loadAsrModel, loadTtsModel, unloadAsrModel, unloadTtsModel } from "@/lib/modelLoader";
import { computeIsLoaded, engineOf, runtimeKeyOf } from "@/lib/modelState";
import { FrameworkPanel } from "./FrameworkPanel";

function refreshModels() {
  void sendToSidecar({ action: "list_models" });
}

/** 引擎徽章配色（仅视觉查表；未登记引擎走默认样式 —— 新增框架无需改前端） */
const ENGINE_BADGE_CLASSES: Record<string, string> = {
  llama: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20",
  sherpa: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20",
  torch: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20",
};

/** GB 数值显示（≥10 不留小数） */
function formatGb(gb: number): string {
  return `${gb.toFixed(gb >= 10 ? 0 : 2)} GB`;
}

/** 模型大小显示：已下载用真实磁盘占用，未下载用清单预估值 */
function formatModelSize(it: ModelItemState): string {
  return formatGb(it.sizeOnDiskGb ?? it.sizeGb);
}

const EMPTY_ITEMS: ModelItemState[] = [];
const EMPTY_ENTRIES: ModelItemState["entries"] = [];

// ============================================================
// 下载设置子页面
// ============================================================

function SettingsPage() {
  const locale = useAppStore((s) => s.locale);
  const modelRoot = useAppStore((s) => s.models.modelRoot);
  const diskFreeGb = useAppStore((s) => s.models.diskFreeGb);
  const proxy = useAppStore((s) => s.models.proxy);
  const downloading = useAppStore((s) => (s.models.items ?? []).some((i) => i.state === "downloading"));
  const [changing, setChanging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [proxyDraft, setProxyDraft] = useState(proxy ?? "");
  useEffect(() => setProxyDraft(proxy ?? ""), [proxy]);
  const proxyValid = proxyDraft.trim() === "" || /^https?:\/\/[^\s:]+:\d{2,5}$/.test(proxyDraft.trim());

  const applyProxy = useCallback(() => {
    const v = proxyDraft.trim();
    if (v && !/^https?:\/\/[^\s:]+:\d{2,5}$/.test(v)) return;
    if (v === (proxy ?? "")) return;
    void sendToSidecar({ action: "set_proxy", proxy: v });
    useAppStore.getState().setProxyLocal(v);
    useAppStore.getState().addLog(`[settings] 🌐 代理已设置: ${v || "（清除）"}`, "info");
    setNotice(null);
  }, [proxyDraft, proxy]);

  const onChange = useCallback(async () => {
    if (downloading || changing) return;
    setChanging(true);
    try {
      const picked = await pickFolder(
        t(locale, "models.storage.title"),
        modelRoot || undefined,
      );
      if (picked && picked !== modelRoot) {
        await sendToSidecar({ action: "set_model_root", path: picked });
        useAppStore.getState().setModelRootLocal(picked);
        // 立即持久化，避免防抖窗口内退出丢失
        void import("@/lib/persistence").then(({ saveConfig }) => saveConfig());
        setNotice(t(locale, "models.rootChanged", { path: picked }));
        refreshModels();
      }
    } finally {
      setChanging(false);
    }
  }, [locale, modelRoot, downloading, changing]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-muted-foreground" />
          {t(locale, "models.storage.title")}
        </CardTitle>
        <CardDescription>{t(locale, "models.storage.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs">
            {modelRoot || "…"}
          </code>
          <Button variant="outline" size="sm" disabled={downloading} onClick={() => void onChange()}>
            {changing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t(locale, "models.storage.change")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!modelRoot}
            onClick={() => modelRoot && void openPath(modelRoot)}
          >
            <FolderOpen className="h-4 w-4" />
            {t(locale, "models.storage.open")}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <span>
            {t(locale, "models.storage.diskFree")}: {diskFreeGb == null ? "—" : `${diskFreeGb} GB`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <label className="shrink-0 text-xs text-muted-foreground">{t(locale, "models.proxy.label")}</label>
          <input
            value={proxyDraft}
            onChange={(e) => setProxyDraft(e.target.value)}
            onBlur={applyProxy}
            onKeyDown={(e) => e.key === "Enter" && applyProxy()}
            placeholder={t(locale, "models.proxy.placeholder")}
            className={`h-7 flex-1 rounded-md border bg-background px-2 font-mono text-xs outline-none focus:ring-1 focus:ring-ring ${
              proxyValid ? "border-input" : "border-destructive"
            }`}
          />
          {proxy && proxyDraft.trim() === proxy && (
            <span className="shrink-0 text-[11px] text-emerald-600 dark:text-emerald-400">
              {t(locale, "models.proxy.applied")}
            </span>
          )}
          {!proxyValid && (
            <span className="shrink-0 text-[11px] text-destructive">{t(locale, "models.proxy.invalid")}</span>
          )}
        </div>

        {notice && <p className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>}
      </CardContent>
    </Card>
  );
}

// ============================================================
// 框架徽章（模型所属推理框架）
// ============================================================

function FrameworkBadge({ name }: { name: string }) {
  const item = useAppStore((s) => s.models.items.find((i) => i.name === name));
  // 徽章文本 = 运行时包 key（缺省退回引擎名/format）；配色按引擎 —— 全部来自 Rust 下发
  const engine = engineOf(item);
  const label = runtimeKeyOf(item) ?? engine ?? "unknown";
  return (
    <Badge
      variant="outline"
      className={`ml-1.5 font-mono text-[10px] uppercase ${ENGINE_BADGE_CLASSES[engine ?? ""] ?? ""}`}
      title={`${engine ?? "unknown"} · ${label}`}
    >
      {label}
    </Badge>
  );
}

// ============================================================
// 模型行组件（列表式，可展开）
// ============================================================

function ModelRow({ name }: { name: string }) {
  const locale = useAppStore((s) => s.locale);
  const item = useAppStore((s) => (s.models.items ?? []).find((i) => i.name === name));
  const asrDevice = useAppStore((s) => s.asr.device);
  const [expanded, setExpanded] = useState(false);
  // 精选条目选择：初值 = 已装条目 ?? 默认条目 ?? 首个条目；下载/切换完成（activeEntry 变化）后同步
  const entries = item?.entries ?? EMPTY_ENTRIES;
  const [selectedEntryId, setSelectedEntryId] = useState(
    () => item?.activeEntry ?? entries.find((e) => e.default)?.id ?? entries[0]?.id ?? "",
  );
  useEffect(() => {
    if (item?.activeEntry) setSelectedEntryId(item.activeEntry);
  }, [item?.activeEntry]);

  if (!item) return null;
  const it = item;
  // 任一引擎加载中 → 禁止加载/卸载/删除（防止快速切换并发）
  const anyLoading = useAppStore((s) => s.engines.asr.status === "loading" || s.engines.tts.status === "loading");

  const isLoaded = computeIsLoaded(it.kind, it.name);
  const isDownloaded = it.state === "downloaded" || isLoaded;
  const isDownloading = it.state === "downloading";
  const isNotDownloaded = it.state === "not_downloaded" && !isLoaded;
  const desc = locale === "zh" ? it.descriptionZh : it.descriptionEn;
  const locked = !it.available;

  // 条目 UI 仅在 1 个以上精选条目时启用；≤1 完全走既有单模型路径（不渲染下拉、下载不带 entry）
  const hasEntryChoice = it.entries.length > 1;
  const selectedEntry = hasEntryChoice ? it.entries.find((e) => e.id === selectedEntryId) : undefined;
  // 选中条目 ≠ 当前已装条目、且其自身非下载中 → 动作区改由该条目状态决定
  // （与 activeEntry 相同 / 条目下载中 → 一律保持既有 加载·卸载·删除·取消 逻辑）
  const entryOverride =
    selectedEntry && selectedEntry.id !== it.activeEntry && selectedEntry.state !== "downloading"
      ? selectedEntry
      : undefined;
  const baseNotDownloaded = !entryOverride && isNotDownloaded;
  const baseDownloaded = !entryOverride && isDownloaded && !isLoaded;
  const baseLoaded = !entryOverride && isLoaded;

  // 状态图标
  function StatusIcon() {
    if (isLoaded) {
      return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">✓</span>;
    }
    if (isDownloaded) {
      return <span className="flex h-5 w-5 items-center justify-center text-muted-foreground">✓</span>;
    }
    return <Download className="h-4 w-4 text-muted-foreground" />;
  }

  // 状态文本
  function StatusBadge() {
    if (locked) return <Badge variant="outline" className="text-muted-foreground">{t(locale, "models.comingSoon")}</Badge>;
    if (isLoaded) return <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">{t(locale, "models.state.in_use")}</Badge>;
    if (isDownloading) {
      return (
        <Badge variant="secondary" className="gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          {it.extracting
            ? t(locale, "models.state.extracting")
            : t(locale, "models.state.downloading", { percent: it.percent ?? 0 })}
        </Badge>
      );
    }
    if (isDownloaded) return <Badge variant="secondary">{t(locale, "models.state.downloaded")}</Badge>;
    return <Badge variant="outline">{t(locale, "models.state.not_downloaded")}</Badge>;
  }

  /** 下载/切换条目：entryId 缺省 = Rust 侧默认条目（无条目概念的模型走这条） */
  async function doDownload(entryId?: string) {
    await sendToSidecar({ action: "download_model", model: it.name, ...(entryId ? { entry: entryId } : {}) });
    refreshModels();
  }
  async function doCancel() {
    useAppStore.setState((s) => ({
      models: { ...s.models, items: (s.models.items ?? []).map((x) => x.name === it.name ? { ...x, cancelRequested: true } : x) },
    }));
    await sendToSidecar({ action: "cancel_download", model: it.name });
  }
  async function doDelete() {
    await sendToSidecar({ action: "delete_model", model: it.name });
    refreshModels();
  }
  async function doUnload() {
    if (it.kind === "tts") {
      await unloadTtsModel();
    } else {
      await unloadAsrModel();
    }
    refreshModels();
  }
  async function doLoad() {
    if (anyLoading) return; // 加载中禁止再切换（全局门禁）
    const device = it.kind === "tts" ? "cpu" : asrDevice;
    if (it.kind === "tts") {
      await loadTtsModel(it.name, device);
    } else {
      await loadAsrModel(it.name, device);
    }
    refreshModels();
  }

  // CPU 模式兼容性：当前设备 + 模型分级 → 加载可用性
  const cpuLevel = it.cpu ?? "good";
  const cpuUnsupported = asrDevice === "cpu" && cpuLevel === "unsupported" && it.kind === "asr";
  const cpuSlow = asrDevice === "cpu" && cpuLevel === "slow" && it.kind === "asr";

  return (
    <div className="rounded-lg border">
      {/* 主行 */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon />
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium">{it.name}</span>
          {it.quant && (
            <Badge variant="outline" className="ml-1.5 font-mono text-[10px] bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/20">
              {it.quant}
            </Badge>
          )}
          <FrameworkBadge name={it.name} />
          {cpuSlow && (
            <Badge variant="outline" className="ml-1 text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20">
              ⚠ {t(locale, "models.cpuSlow")}
            </Badge>
          )}
          {cpuUnsupported && (
            <Badge variant="outline" className="ml-1 text-[10px] bg-destructive/10 text-destructive border-destructive/20">
              {t(locale, "models.cpuUnsupported")}
            </Badge>
          )}
          <span className="ml-2 text-xs text-muted-foreground">{desc}</span>
          {it.source && (
            <span
              className="ml-2 inline-block max-w-[320px] truncate align-bottom font-mono text-[11px] text-muted-foreground/70"
              title={it.source}
            >
              {t(locale, "models.source.label")}: {it.source}
            </span>
          )}
        </div>
        {hasEntryChoice && (
          <span className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <span className="text-[11px] text-muted-foreground">{t(locale, "models.entry.label")}</span>
            <Select value={selectedEntry?.id ?? it.entries[0].id} onValueChange={setSelectedEntryId}>
              <SelectTrigger className="h-7 w-[260px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {it.entries.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {`${locale === "zh" ? e.labelZh : e.labelEn} · ${formatGb(e.sizeGb)} GB`}
                    {e.vramEstimateMb != null
                      ? ` · ${t(locale, "models.entry.vram", { v: (e.vramEstimateMb / 1024).toFixed(2) })}`
                      : ""}
                    {it.activeEntry === e.id ? ` ${t(locale, "models.entry.current")}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
        )}
        <StatusBadge />
        <span className="text-xs text-muted-foreground tabular-nums">{formatModelSize(it)}</span>
        {it.vramEstimateMb != null && (
          <span
            className="text-xs text-sky-600 dark:text-sky-400 tabular-nums"
            title={t(locale, "models.vram.hint")}
          >
            {t(locale, "models.entry.vram", { v: (it.vramEstimateMb / 1024).toFixed(2) })}
          </span>
        )}
        {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
      </div>

      {/* 下载进度 */}
      {isDownloading && (
        <div className="px-4 pb-2 space-y-1">
          <Progress value={it.percent ?? undefined} className="h-1.5" />
          <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
            <span className="truncate">{it.file}</span>
            <span>
              {it.downloadedBytes != null && it.totalBytes != null
                ? `${(it.downloadedBytes / 1024**3).toFixed(2)} / ${(it.totalBytes / 1024**3).toFixed(2)} GB`
                : ""}
            </span>
          </div>
          {it.cancelRequested && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">{t(locale, "models.cancelHint")}</p>
          )}
        </div>
      )}

      {/* 展开详情 */}
      {expanded && (
        <div className="border-t px-4 py-3 space-y-3 bg-muted/20">
          <p className="text-xs text-muted-foreground">{desc}</p>
          <p className="font-mono text-[11px] text-muted-foreground/70 truncate">{it.path}</p>

          {locked ? null : (
            <div className="flex items-center gap-2">
              {/* 选中「非当前已装」条目 → 动作区由该条目状态决定 */}
              {/* 该模型已加载：条目写盘会失败（文件被引擎占用）→ 一并给出卸载入口，避免死路 */}
              {entryOverride && isLoaded && (
                <Button size="sm" variant="outline" disabled={anyLoading} onClick={() => void doUnload()}>
                  <Power className="mr-1.5 h-3.5 w-3.5" />
                  {t(locale, "models.action.unload")}
                </Button>
              )}
              {entryOverride && entryOverride.state === "downloaded" && (
                <Button size="sm" onClick={() => void doDownload(entryOverride.id)}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  {t(locale, "models.entry.switch")}
                </Button>
              )}
              {entryOverride && entryOverride.state === "not_downloaded" && (
                <Button size="sm" onClick={() => void doDownload(entryOverride.id)}>
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {t(locale, "models.action.download", { size: formatGb(entryOverride.sizeGb) })}
                </Button>
              )}
              {/* 未下载 → 下载按钮（有残留目录时附加删除按钮） */}
              {baseNotDownloaded && (
                <>
                  <Button size="sm" onClick={() => void doDownload()}>
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    {t(locale, "models.action.download", { size: formatModelSize(it) })}
                  </Button>
                  {it.dirExists && (
                    <Button size="sm" variant="destructive" onClick={() => void doDelete()}>
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      {t(locale, "models.action.delete")}
                    </Button>
                  )}
                </>
              )}
              {/* 下载中 → 取消按钮 */}
              {isDownloading && (
                <Button size="sm" variant="outline" disabled={it.cancelRequested} onClick={() => void doCancel()}>
                  {it.cancelRequested ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <X className="mr-1.5 h-3.5 w-3.5" />}
                  {t(locale, "models.action.cancel")}
                </Button>
              )}
              {/* 已下载未加载 → 加载 + 删除 */}
              {baseDownloaded && (
                <>
                  <Button size="sm" disabled={anyLoading || cpuUnsupported} title={cpuUnsupported ? t(locale, "models.cpuUnsupported") : undefined} onClick={() => void doLoad()}>
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    {t(locale, "models.action.setActive")}
                  </Button>
                  <Button size="sm" variant="destructive" disabled={anyLoading} onClick={() => void doDelete()}>
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    {t(locale, "models.action.delete")}
                  </Button>
                </>
              )}
              {/* 已加载 → 卸载 + 切换 */}
              {baseLoaded && (
                <>
                  <Button size="sm" variant="outline" disabled={anyLoading} onClick={() => void doUnload()}>
                    <Power className="mr-1.5 h-3.5 w-3.5" />
                    {t(locale, "models.action.unload")}
                  </Button>
                  <Button size="sm" disabled={anyLoading || cpuUnsupported} title={cpuUnsupported ? t(locale, "models.cpuUnsupported") : undefined} onClick={() => void doLoad()}>
                    {t(locale, "models.action.setActive")}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 模型列表页（ASR / TTS 共用，按 kind 过滤）
// ============================================================

function ModelListPage({ kind, title, icon: Icon }: { kind: "asr" | "tts"; title: string; icon: typeof Mic }) {
  const locale = useAppStore((s) => s.locale);
  const items = useAppStore((s) => s.models?.items ?? EMPTY_ITEMS);
  const names = items.filter((i) => i.kind === kind).map((i) => i.name);
  const [everLoaded, setEverLoaded] = useState(items.length > 0);

  useEffect(() => {
    refreshModels();
    const timer = window.setInterval(refreshModels, 3000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (items.length > 0) setEverLoaded(true);
  }, [items.length]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </h3>
        <Button variant="ghost" size="icon" onClick={refreshModels} aria-label="refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {names.length === 0 && everLoaded && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {t(locale, "models.sidecarLost")}
        </p>
      )}

      {names.length === 0 && !everLoaded && (
        <div className="flex h-16 items-center justify-center text-sm text-muted-foreground">…</div>
      )}

      {/* 按引擎分组展示：分组与顺序全部来自 Rust 清单（engine 首次出现顺序，确定性） */}
      {(() => {
        const grouped: Record<string, string[]> = {};
        const order: string[] = [];
        for (const n of names) {
          const item = items.find((i) => i.name === n);
          const eng = engineOf(item) || "unknown"; // 无 engine/data 时的兜底标签
          if (!grouped[eng]) {
            grouped[eng] = [];
            order.push(eng);
          }
          grouped[eng].push(n);
        }
        return order.map((eng) => (
          <div key={eng} className="space-y-2">
            <div className="flex items-center gap-2 pt-1">
              <Badge
                variant="outline"
                className={`font-mono text-[10px] uppercase ${ENGINE_BADGE_CLASSES[eng] ?? ""}`}
              >
                {eng}
              </Badge>
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {eng} · {grouped[eng].length}
              </span>
            </div>
            {grouped[eng].map((n) => <ModelRow key={n} name={n} />)}
          </div>
        ));
      })()}
    </div>
  );
}

// ============================================================
// 主入口：根据子菜单切换页面
// ============================================================

export function ModelsPanel() {
  const sub = useAppStore((s) => s.activeSubMenu);
  const locale = useAppStore((s) => s.locale);

  if (sub === "settings") {
    return <SettingsPage />;
  }

  if (sub === "framework") {
    return <FrameworkPanel />;
  }

  if (sub === "asr") {
    return <ModelListPage kind="asr" title={t(locale, "models.group.asr")} icon={Mic} />;
  }

  // tts
  return <ModelListPage kind="tts" title={t(locale, "models.group.tts")} icon={Volume2} />;
}
