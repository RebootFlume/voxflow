import { useCallback, useEffect, useState } from "react";
import { FileAudio, Play, Trash2, Loader2, FolderOpen } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAppStore } from "@/stores";
import { t } from "@/lib/i18n";
import { rustTranscribeLlama } from "@/lib/tauri";
import { useExportDir } from "@/lib/useExportDir";

const FORMAT_KEYS = [
  { value: "txt", labelKey: "asr.transcribe.format.txt" },
  { value: "srt", labelKey: "asr.transcribe.format.srt" },
  { value: "vtt", labelKey: "asr.transcribe.format.vtt" },
  { value: "json", labelKey: "asr.transcribe.format.json" },
  { value: "lrc", labelKey: "asr.transcribe.format.lrc" },
];

// soundfile 原生支持的格式（不需要 FFmpeg）
const NATIVE_FORMATS = new Set(["wav", "flac", "ogg"]);

function getFileExt(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function getFormatInfo(ext: string, ffmpeg: boolean): { label: string; supported: boolean } {
  if (NATIVE_FORMATS.has(ext)) return { label: ext.toUpperCase(), supported: true };
  if (ffmpeg) return { label: ext.toUpperCase(), supported: true };
  return { label: ext.toUpperCase(), supported: false };
}

export function TranscribePanel() {
  const locale = useAppStore((s) => s.locale);
  const ffmpeg = useAppStore((s) => s.capabilities.ffmpeg);
  const tasks = useAppStore((s) => s.transcribeTasks);
  const [format, setFormat] = useState("txt");
  const [busy, setBusy] = useState(false);
  const { exportDir, setExportDir } = useExportDir();

  // 弹出系统文件夹选择器
  const browseDir = useCallback(async () => {
    const picked = await import("@tauri-apps/plugin-dialog").then((m) =>
      m.open({ directory: true, multiple: false, title: t(locale, "common.selectDir"), defaultPath: exportDir || undefined })
    );
    if (picked && typeof picked === "string") {
      setExportDir(picked);
    }
  }, [exportDir, setExportDir]);

  // 事件监听已移到 App.tsx（全局挂载），组件只管 UI

  // 获取默认导出路径
  // 默认导出目录由 useStartupFallback 统一请求，这里只监听结果作为兜底

  async function selectFiles() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const files = await open({
      multiple: true,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "ogg", "m4a", "webm"] }],
    });
    if (!files) return;
    const paths = Array.isArray(files) ? files : [files];
    const store = useAppStore.getState();
    for (const p of paths) {
      const full = p.split(/[/\\]/).pop() ?? p;
      const name = full.length > 35 ? full.slice(0, 30) + "…" + full.slice(-4) : full;
      store.addTranscribeTask({ fileName: name, filePath: p, status: "pending" });
    }
  }

  async function startTranscribe() {
    const pending = tasks.filter((t) => t.status === "pending");
    if (pending.length === 0) return;
    setBusy(true);
    const store = useAppStore.getState();

    for (const task of pending) {
      store.updateTranscribeTask(task.filePath, { status: "transcribing", progress: 0, doneSec: 0, totalSec: 0 });

      try {
        const result = await rustTranscribeLlama(task.filePath);
        store.updateTranscribeTask(task.filePath, {
          status: "done",
          progress: 100,
          result: result.text,
          doneSec: result.duration,
          totalSec: result.duration,
        });
      } catch (e) {
        store.updateTranscribeTask(task.filePath, { status: "error", error: String(e) });
      }
    }
    setBusy(false);
  }

  useEffect(() => {
    if (!busy) return;
    if (tasks.every((t) => t.status !== "transcribing" && t.status !== "pending")) setBusy(false);
  }, [tasks, busy]);

  async function removeTask(id: number) {
    useAppStore.getState().removeTranscribeTask(id);
  }

  const doneCount = tasks.filter((t) => t.status === "done").length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t(locale, "asr.transcribe.title")}</CardTitle>
          <CardDescription>{t(locale, "asr.transcribe.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void selectFiles()}>
              <FileAudio className="mr-2 h-4 w-4" />
              {t(locale, "asr.transcribe.select")}
            </Button>
            <Button onClick={() => void startTranscribe()} disabled={busy || tasks.filter((t) => t.status === "pending").length === 0}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              {t(locale, "asr.transcribe.start")}
            </Button>
            <div className="flex items-center gap-1.5 ml-2">
              <Select value={format} onValueChange={setFormat}>
                <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FORMAT_KEYS.map((f) => <SelectItem key={f.value} value={f.value}>{t(locale, f.labelKey)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground shrink-0">{t(locale, "asr.transcribe.exportDir")}</label>
            <Input
              value={exportDir}
              readOnly
              placeholder={t(locale, "asr.transcribe.clickToSelect")}
              className="h-8 text-xs flex-1 cursor-pointer"
              onClick={() => void browseDir()}
            />
            <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1" onClick={() => void browseDir()}>
              <FolderOpen className="h-3.5 w-3.5" />
              {t(locale, "asr.transcribe.browse")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {ffmpeg
              ? t(locale, "asr.transcribe.formatsWithFfmpeg")
              : t(locale, "asr.transcribe.formatsWithoutFfmpeg")}
          </p>
          {tasks.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t(locale, "asr.transcribe.fileCount", { n: String(tasks.length) })}
              {doneCount > 0 && ` · ${doneCount} ${t(locale, "asr.transcribe.done")}`}
            </p>
          )}
        </CardContent>
      </Card>

      {tasks.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t(locale, "asr.transcribe.preview")}</CardTitle></CardHeader>
          <CardContent>
            <ScrollArea className="max-h-96">
              <div className="space-y-3">
                {tasks.map((task) => (
                  <div key={task.id} className="rounded-lg border p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium" title={task.filePath}>{task.fileName}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Badge variant="outline" className="text-[10px] px-1 py-0">
                          {(() => { const info = getFormatInfo(getFileExt(task.filePath), ffmpeg); return info.supported ? info.label : `${info.label} ⚠️`; })()}
                        </Badge>
                        <Badge
                          variant={
                            task.status === "done" ? "default" :
                            task.status === "error" ? "destructive" :
                            task.status === "transcribing" ? "secondary" : "outline"
                          }
                          className="text-[10px] px-1.5 py-0"
                        >
                          {task.status === "done" ? t(locale, "asr.transcribe.done") :
                           task.status === "error" ? "✗" :
                           task.status === "transcribing" ? t(locale, "asr.transcribe.processing") : "…"}
                        </Badge>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removeTask(task.id)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    {task.error && <p className="text-xs text-destructive">{task.error}</p>}
                    {task.status === "transcribing" && task.progress != null && (
                      <div className="space-y-1">
                        <Progress value={task.progress} className="h-1.5" />
                        <div className="flex justify-between text-[11px] text-muted-foreground">
                          <span>
                            {task.doneSec != null && task.totalSec != null && task.totalSec > 0
                              ? `${task.doneSec.toFixed(1)}s / ${task.totalSec.toFixed(1)}s`
                              : t(locale, "asr.transcribe.analyzing")}
                          </span>
                          <span>{task.progress}%</span>
                        </div>
                      </div>
                    )}
                    {task.result && <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-6">{task.result}</p>}
                    {task.savedPath && (
                      <p className="text-[11px] text-emerald-600 dark:text-emerald-400 truncate" title={task.savedPath}>
                        ✓ {t(locale, "asr.transcribe.saved")}: {task.savedPath.split(/[/\\]/).pop()}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
