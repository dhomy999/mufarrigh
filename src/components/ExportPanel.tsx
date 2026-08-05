"use client";

/**
 * ═══════════════════════════════════════════════════════════════
 *  ExportPanel.tsx
 *  لوحة التصدير النهائي + توليد Shorts الذكي
 *
 *  الميزات:
 *    1. تصدير الفيديو النهائي بعد إزالة الأجزاء المحذوفة
 *    2. توليد مقاطع قصيرة (Shorts) عبر LLM (GPT-4o / Claude)
 *    3. استخراج كل Short كملف منفصل
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useCallback, useMemo } from "react";
import ShortPreview from "./ShortPreview";
import {
  exportVideo,
  generateShorts,
  extractShort,
  revealInFolder,
  pickOutputFolder,
  formatTime,
  type TimeRange,
  type ExportResult,
  type ShortSuggestion,
  type ShortExtractResult,
  type TranscriptionResult,
} from "@/lib/tauri-api";
import type { ExcludedRange, WordState } from "@/lib/editor-utils";
import { buildSubtitleCues, toSRT, toVTT, clipCuesToRange } from "@/lib/subtitle-utils";
import { useSettings, resolveTaskModel } from "@/lib/settings";

interface ExportPanelProps {
  videoPath: string;
  excludedRanges: ExcludedRange[];
  transcription: TranscriptionResult;
  /** كلمات المحرر بحالتها الحالية (تعديلات + حذف) — لتوليد الترجمة */
  words: WordState[];
  deletedCount: number;
  /** عدد فترات السكتات المحدَّدة للحذف (قادمة من خطوة كشف السكتات) */
  silenceCount?: number;
  onOpenSettings: () => void;
}

export default function ExportPanel({
  videoPath,
  excludedRanges,
  transcription,
  words,
  deletedCount,
  silenceCount = 0,
  onOpenSettings,
}: ExportPanelProps) {
  const { settings, update } = useSettings();
  // ─── حالات التصدير ──────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // ─── حالات Shorts — النموذج والبرومت يُداران من الإعدادات ──────
  const shortsTask = settings.tasks.generateShorts;
  const shortsModel = resolveTaskModel(settings, "generateShorts");
  const [shortsLoading, setShortsLoading] = useState(false);
  const [shorts, setShorts] = useState<ShortSuggestion[]>([]);
  const [shortsError, setShortsError] = useState<string | null>(null);
  const [extractingIndex, setExtractingIndex] = useState<number | null>(null);
  const [extractedShorts, setExtractedShorts] = useState<
    Record<number, ShortExtractResult>
  >({});

  // ─── خيارات الاستخراج لكل مقطع (plan.md §4.2/§4.3) ──────────────
  const [shortTemplate, setShortTemplate] = useState<
    Record<number, "original" | "blur-9x16" | "crop-9x16">
  >({});
  const [shortBurn, setShortBurn] = useState<Record<number, boolean>>({});
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const videoUrl = useMemo(() => videoPath, [videoPath]);

  // ─── تصدير الفيديو ───────────────────────────────────────────
  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    setExportResult(null);

    try {
      // تحويل ExcludedRange[] إلى TimeRange[]
      const ranges: TimeRange[] = excludedRanges.map((r) => ({
        start: r.start,
        end: r.end,
      }));

      const result = await exportVideo(videoPath, ranges, settings.outputDir || undefined);
      setExportResult(result);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "فشل التصدير");
    } finally {
      setExporting(false);
    }
  }, [videoPath, excludedRanges, settings.outputDir]);

  // ─── اختيار مجلد المخرجات (plan.md §0.5) ────────────────────
  const handlePickOutputFolder = useCallback(async () => {
    try {
      const folder = await pickOutputFolder();
      if (folder !== null) {
        update({ ...settings, outputDir: folder });
      }
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : "تعذّر اختيار المجلد"
      );
    }
  }, [settings, update]);

  const handleResetOutputFolder = useCallback(() => {
    update({ ...settings, outputDir: "" });
  }, [settings, update]);

  const outputLabel = settings.outputDir
    ? settings.outputDir
    : "مجلد الكاش (الافتراضي)";

  // ─── توليد Shorts ────────────────────────────────────────────
  const handleGenerateShorts = useCallback(async () => {
    if (!shortsModel || !shortsModel.apiKey.trim()) {
      setShortsError("اختر نموذجاً لمهمة «توليد Shorts» وأضف مفتاحه من الإعدادات");
      onOpenSettings();
      return;
    }

    setShortsLoading(true);
    setShortsError(null);
    setShorts([]);

    try {
      const transcriptJson = JSON.stringify({
        words: transcription.words.map((w) => ({
          word: w.word,
          start: w.start,
          end: w.end,
        })),
      });

      const result = await generateShorts(
        transcriptJson,
        shortsModel.apiKey,
        shortsModel.provider,
        shortsModel.model,
        shortsTask.prompt
      );
      setShorts(result);
    } catch (err) {
      setShortsError(err instanceof Error ? err.message : "فشل توليد Shorts");
    } finally {
      setShortsLoading(false);
    }
  }, [shortsModel, shortsTask, transcription, onOpenSettings]);

  // ─── استخراج Short ───────────────────────────────────────────
  const handleExtractShort = useCallback(
    async (suggestion: ShortSuggestion, index: number) => {
      setExtractingIndex(index);

      try {
        const template = shortTemplate[index] ?? "original";
        const burn = shortBurn[index] ?? false;

        // SRT مقصوص على نطاق المقطع (plan.md §4.1)
        const cues = buildSubtitleCues(words, [], false);
        const clipped = clipCuesToRange(cues, suggestion.start, suggestion.end);
        const srtContent = burn ? toSRT(clipped) : undefined;

        const result = await extractShort(
          videoPath,
          suggestion.start,
          suggestion.end,
          suggestion.title,
          settings.outputDir || undefined,
          { template, burnSubtitles: burn, srtContent }
        );
        setExtractedShorts((prev) => ({ ...prev, [index]: result }));
      } catch (err) {
        setShortsError(err instanceof Error ? err.message : "فشل الاستخراج");
      } finally {
        setExtractingIndex(null);
      }
    },
    [videoPath, settings.outputDir, words, shortTemplate, shortBurn]
  );

  // ─── فتح مجلد المخرجات ───────────────────────────────────────
  const handleReveal = useCallback(async (path: string) => {
    try {
      await revealInFolder(path);
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : "تعذّر فتح مجلد المخرجات"
      );
    }
  }, []);

  // ─── تصدير الترجمة (SRT / WebVTT) ────────────────────────────
  // مطابقة توقيت الفيديو المُصدَّر: تُزاح التوقيتات بطرح الفترات المحذوفة
  const [subtitleRemap, setSubtitleRemap] = useState(true);

  const videoStem = useMemo(() => {
    const base = videoPath.split(/[\\/]/).pop() ?? "video";
    return base.replace(/\.[^.]+$/, "");
  }, [videoPath]);

  const subtitleCues = useMemo(
    () =>
      buildSubtitleCues(
        words,
        excludedRanges,
        subtitleRemap && excludedRanges.length > 0
      ),
    [words, excludedRanges, subtitleRemap]
  );

  const handleExportSubtitle = useCallback(
    (format: "srt" | "vtt") => {
      const content = format === "srt" ? toSRT(subtitleCues) : toVTT(subtitleCues);
      const blob = new Blob([content], {
        type: format === "srt" ? "application/x-subrip" : "text/vtt",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${videoStem}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [subtitleCues, videoStem]
  );

  return (
    <div className="flex flex-col gap-4 p-4 bg-surface rounded-xl border border-border">
      {/* ═══ التصدير النهائي ═══ */}
      <section>
        <h3 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          التصدير النهائي
        </h3>

        <div className="text-xs text-muted mb-3 space-y-1">
          <p>سيتم إزالة <span className="text-danger font-bold">{deletedCount}</span> كلمة من الفيديو</p>
          {silenceCount > 0 && (
            <p>سكتات محدَّدة للحذف: <span className="text-accent font-bold">{silenceCount}</span></p>
          )}
          <p>إجمالي المقاطع المحذوفة: <span className="text-accent font-bold">{excludedRanges.length}</span></p>
        </div>

        {/* مجلد المخرجات (plan.md §0.5) */}
        <div className="mb-3 flex items-center justify-between gap-2 p-2.5 rounded-lg bg-background border border-border">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] text-muted">مجلد المخرجات</p>
            <p className="text-xs text-foreground truncate" dir="ltr" title={outputLabel}>
              {outputLabel}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {settings.outputDir && (
              <button
                onClick={handleResetOutputFolder}
                className="text-xs text-muted hover:text-danger px-2 py-1 rounded hover:bg-danger/10 transition-colors"
                title="العودة لمجلد الكاش"
              >
                إعادة الضبط
              </button>
            )}
            <button
              onClick={handlePickOutputFolder}
              className="text-xs text-primary hover:text-primary-hover font-bold px-2 py-1 rounded hover:bg-primary/10 transition-colors"
            >
              تغيير
            </button>
          </div>
        </div>

        <button
          onClick={handleExport}
          disabled={exporting || excludedRanges.length === 0}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-white text-sm font-bold hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {exporting ? (
            <>
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.4 0 0 5.4 0 12h4z" />
              </svg>
              جاري التصدير...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              تصدير الفيديو النهائي (MP4)
            </>
          )}
        </button>

        {excludedRanges.length === 0 && (
          <p className="text-[10px] text-muted mt-2 text-center">
            لا توجد أجزاء محذوفة — حدّد كلمات في المحرر أو سكتات في خطوة كشف السكتات أولاً
          </p>
        )}

        {/* نتيجة التصدير */}
        {exportResult && (
          <div className="mt-3 p-3 rounded-lg bg-success/10 border border-success/30">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-success text-lg">✅</span>
              <span className="text-sm font-bold text-success">تم التصدير بنجاح</span>
            </div>
            <div className="text-xs space-y-1 text-foreground/80">
              <div className="flex justify-between">
                <span className="text-muted">الحجم:</span>
                <span className="font-bold">{exportResult.output_size_mb.toFixed(2)} MB</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">المدة الأصلية:</span>
                <span>{formatTime(exportResult.original_duration)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">المدة النهائية:</span>
                <span className="font-bold text-success">{formatTime(exportResult.final_duration)}</span>
              </div>
              <div className="mt-2 pt-2 border-t border-success/20">
                <button
                  onClick={() => handleReveal(exportResult.output_path)}
                  title={exportResult.output_path}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-success/15 text-success text-xs font-bold hover:bg-success/25 transition-colors"
                >
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  فتح مجلد المخرجات
                </button>
              </div>
            </div>
          </div>
        )}

        {exportError && (
          <div className="mt-3 p-3 rounded-lg bg-danger/10 border border-danger/30">
            <div className="flex items-center gap-2">
              <span className="text-danger text-lg">❌</span>
              <span className="text-sm text-danger">{exportError}</span>
            </div>
          </div>
        )}
      </section>

      {/* ═══ فاصل ═══ */}
      <div className="h-px bg-border" />

      {/* ═══ تصدير الترجمة ═══ */}
      <section>
        <h3 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <line x1="6" y1="14" x2="12" y2="14" />
            <line x1="15" y1="14" x2="18" y2="14" />
            <line x1="6" y1="17" x2="9" y2="17" />
            <line x1="12" y1="17" x2="18" y2="17" />
          </svg>
          تصدير الترجمة
        </h3>

        <p className="text-xs text-muted mb-3">
          <span className="font-bold text-foreground">{subtitleCues.length}</span> سطر ترجمة
          من <span className="font-bold text-foreground">{words.filter((w) => !w.deleted && w.word.trim() !== "").length}</span> كلمة
        </p>

        {excludedRanges.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-foreground/80 mb-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={subtitleRemap}
              onChange={(e) => setSubtitleRemap(e.target.checked)}
              className="accent-primary w-3.5 h-3.5"
            />
            <span>
              مطابقة التوقيت للفيديو المُصدَّر (بعد حذف المقاطع)
            </span>
          </label>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => handleExportSubtitle("srt")}
            disabled={subtitleCues.length === 0}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary/10 text-primary text-xs font-bold hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            SRT
          </button>
          <button
            onClick={() => handleExportSubtitle("vtt")}
            disabled={subtitleCues.length === 0}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary/10 text-primary text-xs font-bold hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            WebVTT
          </button>
        </div>
      </section>

      {/* ═══ فاصل ═══ */}
      <div className="h-px bg-border" />

      {/* ═══ Shorts الذكي ═══ */}
      <section>
        <h3 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          توليد Shorts ذكي
        </h3>

        {/* النموذج والبرومت يُداران من قسم «مهام النماذج النصية» في الإعدادات */}
        <div className="space-y-2 mb-3">
          <div className="flex-1 flex items-center justify-between bg-background border border-border rounded-lg px-3 py-2 text-xs">
            <span className={shortsModel?.apiKey ? "text-success" : "text-muted"}>
              {shortsModel
                ? shortsModel.apiKey
                  ? `✅ ${shortsModel.name || shortsModel.model}`
                  : `⚠️ ${shortsModel.name || shortsModel.model} — بلا مفتاح`
                : "⚠️ لم يُختَر نموذج"}
            </span>
            <button
              onClick={onOpenSettings}
              className="text-primary hover:text-primary-hover font-medium"
            >
              الإعدادات
            </button>
          </div>
        </div>

        <button
          onClick={handleGenerateShorts}
          disabled={shortsLoading}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-accent text-white text-sm font-bold hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {shortsLoading ? (
            <>
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.4 0 0 5.4 0 12h4z" />
              </svg>
              يحلّل الذكاء الاصطناعي...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
              اقترح أفضل اللحظات
            </>
          )}
        </button>

        {shortsError && (
          <div className="mt-3 p-3 rounded-lg bg-danger/10 border border-danger/30">
            <span className="text-sm text-danger">❌ {shortsError}</span>
          </div>
        )}

        {/* قائمة المقاطع المقترحة */}
        {shorts.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted">
              تم اقتراح <span className="font-bold text-accent">{shorts.length}</span> مقطع:
            </p>
            {shorts.map((short, i) => {
              const dur = short.end - short.start;
              const extracted = extractedShorts[i];

              return (
                <div
                  key={i}
                  className="p-3 rounded-lg bg-background border border-border hover:border-accent/50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h4 className="text-sm font-bold text-foreground flex-1">
                      {short.title}
                    </h4>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/20 text-accent font-bold shrink-0">
                      {dur.toFixed(0)}s
                    </span>
                  </div>

                  <div className="text-[10px] text-muted mb-2 flex gap-3">
                    <span>⏱ {formatTime(short.start)} → {formatTime(short.end)}</span>
                  </div>

                  {short.reason && (
                    <p className="text-[11px] text-foreground/60 italic mb-2">
                      💡 {short.reason}
                    </p>
                  )}

                  {extracted ? (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2 text-[11px] text-success">
                        <span>✅ {extracted.message}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleReveal(extracted.output_path)}
                          title={extracted.output_path}
                          className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-success/15 text-success text-xs font-bold hover:bg-success/25 transition-colors"
                        >
                          <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                          </svg>
                          MP4
                        </button>
                        {extracted.srt_path && (
                          <button
                            onClick={() => handleReveal(extracted.srt_path!)}
                            title={extracted.srt_path!}
                            className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-success/15 text-success text-xs font-bold hover:bg-success/25 transition-colors"
                          >
                            📝 SRT
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-[11px]">
                        <label className="text-muted shrink-0">القالب:</label>
                        <select
                          value={shortTemplate[i] ?? "original"}
                          onChange={(e) =>
                            setShortTemplate((p) => ({
                              ...p,
                              [i]: e.target.value as "original" | "blur-9x16" | "crop-9x16",
                            }))
                          }
                          className="flex-1 px-2 py-1 rounded bg-background border border-border text-xs focus:outline-none focus:border-primary"
                        >
                          <option value="original">الأصلي</option>
                          <option value="blur-9x16">9:16 ضبابي</option>
                          <option value="crop-9x16">9:16 اقتصاص</option>
                        </select>
                      </div>
                      <label className="flex items-center gap-2 text-[11px] text-foreground/80 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={shortBurn[i] ?? false}
                          onChange={(e) =>
                            setShortBurn((p) => ({ ...p, [i]: e.target.checked }))
                          }
                          className="accent-primary w-3.5 h-3.5"
                        />
                        <span>ترجمة محروقة + SRT مقصوص</span>
                      </label>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setPreviewIndex(i)}
                          title="معاينة المقطع قبل الاستخراج (§4.4)"
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface-hover text-foreground text-xs font-bold hover:bg-border transition-colors"
                        >
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                          معاينة
                        </button>
                        <button
                          onClick={() => handleExtractShort(short, i)}
                          disabled={extractingIndex === i}
                          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1 rounded-lg bg-primary/10 text-primary text-xs font-bold hover:bg-primary/20 disabled:opacity-40 transition-colors"
                        >
                          {extractingIndex === i ? (
                            <>
                              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.4 0 0 5.4 0 12h4z" />
                              </svg>
                              يستخرج…
                            </>
                          ) : (
                            <>
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                              </svg>
                              استخراج
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {previewIndex !== null && shorts[previewIndex] && (
        <ShortPreview
          videoUrl={videoUrl}
          start={shorts[previewIndex].start}
          end={shorts[previewIndex].end}
          title={shorts[previewIndex].title}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </div>
  );
}
