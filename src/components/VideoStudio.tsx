"use client";

/**
 * ═══════════════════════════════════════════════════════════════
 *  VideoStudio.tsx
 *  استوديو تحرير الفيديو (مسار الفيديو) — يجمع:
 *    - مشغل الفيديو الذكي
 *    - محرر النصوص التفاعلي
 *    - إدارة الحالة المركزية (excludedTimeRanges)
 *    - لوحة التصدير النهائي + Shorts الذكي
 *    - شريط أدوات + إحصائيات
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import VideoPlayer from "./VideoPlayer";
import TextEditor from "./TextEditor";
import ExportPanel from "./ExportPanel";
import SettingsModal from "./SettingsModal";
import { detectTranscriptIssues } from "@/lib/tauri-api";
import type { TranscriptionResult, VideoInfo, TranscriptIssue } from "@/lib/tauri-api";
import type { WordState, ExcludedRange } from "@/lib/editor-utils";
import { useSettings, resolveTaskModel } from "@/lib/settings";
import {
  deletedWordsToRanges,
  mergeRanges,
  totalExcludedDuration,
  formatTimeShort,
} from "@/lib/editor-utils";
import { useUndoable } from "@/hooks/useUndoable";

interface VideoStudioProps {
  video: VideoInfo;
  transcription: TranscriptionResult;
  /** فترات السكتات المحدَّدة للحذف من خطوة كشف السكتات (تُقتطع نهائياً) */
  silenceRanges?: ExcludedRange[];
  /** كلمات مستعادة من مشروع محفوظ أو جلسة استوديو سابقة */
  initialWords?: WordState[];
  /** يُستدعى (بتأخير) عند تغيّر الكلمات — للحفظ التلقائي للمشروع */
  onWordsChange?: (words: WordState[]) => void;
  onExit: () => void;
  /** مبدّل المسار: حوّل إلى مسار النصّ (نفس البيانات) — plan.md §3.2 */
  onSwitchMode?: () => void;
}

export default function VideoStudio({
  video,
  transcription,
  silenceRanges = [],
  initialWords,
  onWordsChange,
  onExit,
  onSwitchMode,
}: VideoStudioProps) {
  // ─── كلمات المحرر مع تاريخ التراجع/الإعادة (plan.md §0.4) ─────
  const {
    value: words,
    set: setWords,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useUndoable<WordState[]>(() =>
    initialWords && initialWords.length > 0
      ? initialWords
      : transcription.words.map((w, i) => ({
          id: i,
          word: w.word,
          start: w.start,
          end: w.end,
          deleted: false,
          // درجة ثقة النموذج (Speechmatics فقط) — تُستخدم لتلوين الكلمات المشكوك فيها
          confidence: w.confidence,
        }))
  );

  // ─── إبلاغ الأب بتغيّر الكلمات — يتجاهل أول تصيير ────────────
  // فوري (بلا تأخير) كي يبقى studioWords محدّثاً عند تبديل المسار.
  const skipFirstWordsSync = useRef(true);
  useEffect(() => {
    if (skipFirstWordsSync.current) {
      skipFirstWordsSync.current = false;
      return;
    }
    onWordsChange?.(words);
  }, [words, onWordsChange]);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [currentTime, setCurrentTime] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [showExportPanel, setShowExportPanel] = useState(false);

  // ─── الإعدادات + كشف الأخطاء (Gemini) ───────────────────────────
  const { settings } = useSettings();
  const [showSettings, setShowSettings] = useState(false);
  const [issues, setIssues] = useState<TranscriptIssue[] | null>(null);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [showIssues, setShowIssues] = useState(false);

  // ─── تحويل مسار الفيديو لرابط قابل للتشغيل ────────────────────
  useEffect(() => {
    (async () => {
      try {
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        setVideoUrl(convertFileSrc(video.path));
      } catch {
        setVideoUrl(`file://${video.path}`);
      }
    })();
  }, [video.path]);

  // ─── الفترات المحذوفة = الكلمات المحذوفة + السكتات المحدَّدة للحذف ──
  const excludedRanges: ExcludedRange[] = useMemo(
    () => mergeRanges([...deletedWordsToRanges(words), ...silenceRanges]),
    [words, silenceRanges]
  );

  const excludedDuration = useMemo(
    () => totalExcludedDuration(excludedRanges),
    [excludedRanges]
  );

  // ─── الكلمة المشغّلة حالياً ───────────────────────────────────
  const playingWordId = useMemo(() => {
    for (let i = 0; i < words.length; i++) {
      if (currentTime >= words[i].start && currentTime < words[i].end) {
        return words[i].deleted ? null : i;
      }
    }
    return null;
  }, [currentTime, words]);

  // ─── معالجات التبديل بين الحذف والاستعادة ────────────────────
  const handleToggleDelete = useCallback((ids: number[]) => {
    setWords((prev) =>
      prev.map((w) =>
        ids.includes(w.id) ? { ...w, deleted: !w.deleted } : w
      )
    );
  }, [setWords]);

  // ─── تعديل نصّ كلمة (يحتفظ بنفس التوقيت الزمني) ────────────────
  const handleEditWord = useCallback((id: number, newText: string) => {
    setWords((prev) =>
      prev.map((w) =>
        w.id === id && w.word !== newText
          ? { ...w, word: newText, edited: true }
          : w
      )
    );
    // إزالة أي علامة خطأ على كلمة صُحّحت يدوياً
    setIssues((prev) => {
      if (!prev) return prev;
      const w = words.find((x) => x.id === id);
      if (!w) return prev;
      return prev.filter((iss) => !(w.start < iss.end && w.end > iss.start));
    });
  }, [words, setWords]);

  // ─── قبول تصحيح خطأ: يطبّق الاقتراح على كلمات النطاق ──────────
  // النص المُصحَّح يحلّ محل الكلمة الأولى في النطاق، وتُفرَّغ البقية
  // (لا تُحذف حتى لا يُقتطع الصوت) — فيبقى التوقيت الزمني سليماً.
  const handleAcceptIssue = useCallback(
    (index: number) => {
      const issue = issues?.[index];
      if (!issue) return;
      const suggestion = (issue.suggestion ?? "").trim();
      if (suggestion) {
        setWords((prev) => {
          const inRange = prev
            .filter((w) => !w.deleted && w.start < issue.end && w.end > issue.start)
            .sort((a, b) => a.start - b.start);
          if (inRange.length === 0) return prev;
          const firstId = inRange[0].id;
          const restIds = new Set(inRange.slice(1).map((w) => w.id));
          return prev.map((w) => {
            if (w.id === firstId) return { ...w, word: suggestion, edited: true };
            if (restIds.has(w.id)) return { ...w, word: "", edited: true };
            return w;
          });
        });
      }
      setIssues((prev) => (prev ? prev.filter((_, i) => i !== index) : prev));
    },
    [issues, setWords]
  );

  // ─── تجاهل خطأ: إزالته من القائمة دون تغيير النص ──────────────
  const handleIgnoreIssue = useCallback((index: number) => {
    setIssues((prev) => (prev ? prev.filter((_, i) => i !== index) : prev));
  }, []);

  // ─── خريطة الكلمات المُعلَّمة بخطأ (wordId → الخطورة) ──────────
  const markedWords = useMemo(() => {
    const map = new Map<number, string>();
    if (!issues) return map;
    for (const issue of issues) {
      for (const w of words) {
        if (!w.deleted && w.start < issue.end && w.end > issue.start && !map.has(w.id)) {
          map.set(w.id, issue.severity);
        }
      }
    }
    return map;
  }, [issues, words]);

  const handleTimeUpdate = useCallback((time: number) => {
    setCurrentTime(time);
  }, []);

  // ─── القفز لموضع زمني في الفيديو ─────────────────────────────
  const seekTo = useCallback((time: number) => {
    const videoEl = document.querySelector("video");
    if (videoEl) videoEl.currentTime = time;
  }, []);

  // ─── كشف الأخطاء غير المنطقية عبر النموذج المختار للمهمة ─────────
  const handleDetectIssues = useCallback(async () => {
    const task = settings.tasks.detectIssues;
    const model = resolveTaskModel(settings, "detectIssues");
    if (!model || !model.apiKey.trim()) {
      setShowSettings(true);
      return;
    }
    setIssuesLoading(true);
    setIssuesError(null);
    setShowIssues(true);
    try {
      const transcriptJson = JSON.stringify({
        words: words.map((w) => ({ word: w.word, start: w.start, end: w.end })),
      });
      const result = await detectTranscriptIssues(
        transcriptJson,
        model.apiKey,
        model.provider,
        model.model,
        "ar",
        task.prompt
      );
      setIssues(result);
    } catch (e) {
      const err = e as { message?: string; details?: string };
      setIssuesError(
        err.details ? `${err.message ?? "فشل كشف الأخطاء"}\n${err.details}` : err.message ?? "فشل كشف الأخطاء"
      );
    } finally {
      setIssuesLoading(false);
    }
  }, [settings, words]);

  // ─── اختصارات لوحة المفاتيح العامة ────────────────────────────
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const inField = (e.target as HTMLElement)?.matches(
        "input, textarea, select"
      );
      // ─── تراجع/إعادة على مستوى العمليات (plan.md §0.4) ───
      // داخل حقول الإدخال يُترك التراجع الأصلي للمتصفّح (التحرير الإنلاين)
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !inField && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && !inField && key === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (e.code === "Space" && !inField) {
        e.preventDefault();
        const video = document.querySelector("video");
        if (video) {
          if (video.paused) video.play();
          else video.pause();
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [undo, redo]);

  // ─── إحصائيات ────────────────────────────────────────────────
  const deletedCount = words.filter((w) => w.deleted).length;
  const activeCount = words.length - deletedCount;
  const originalDuration = transcription.duration;

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* ═══ شريط الأدوات العلوي ═══ */}
      <header className="flex items-center justify-between px-4 py-2.5 bg-surface border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onExit}
            className="flex items-center gap-1.5 text-sm text-muted hover:text-foreground px-3 py-1.5 rounded-lg hover:bg-surface-hover transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 18l6-6-6-6" />
            </svg>
            رجوع
          </button>

          {/* تراجع / إعادة (plan.md §0.4) */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={undo}
              disabled={!canUndo}
              title="تراجع (Ctrl+Z)"
              className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-surface-hover disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 14 4 9 9 4" />
                <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
              </svg>
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              title="إعادة (Ctrl+Shift+Z)"
              className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-surface-hover disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 14 20 9 15 4" />
                <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
              </svg>
            </button>
          </div>

          <div className="h-5 w-px bg-border" />

          <h1 className="text-sm font-bold text-foreground">استوديو التحرير</h1>
          <span className="text-xs text-muted truncate max-w-[200px]">
            {video.file_name}
          </span>
        </div>

        {/* إحصائيات */}
        <div className="flex items-center gap-4 text-xs">
          <Stat label="كلمات" value={activeCount} color="text-foreground" />
          <Stat label="محذوفة" value={deletedCount} color="text-danger" />
          <Stat
            label="مدة محذوفة"
            value={`${excludedDuration.toFixed(1)}ث`}
            color="text-accent"
          />
          <Stat
            label="المدة النهائية"
            value={formatTimeShort(originalDuration - excludedDuration)}
            color="text-success"
          />
        </div>

        <div className="flex items-center gap-2">
          {/* مبدّل المسار (plan.md §3.2) */}
          {onSwitchMode && (
            <button
              onClick={onSwitchMode}
              title="حوّل إلى مسار النصّ (نفس البيانات)"
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-surface-hover text-foreground hover:bg-border transition-colors font-medium"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              مسار النصّ
            </button>
          )}

          {/* زر كشف الأخطاء (Gemini) */}
          <button
            onClick={handleDetectIssues}
            disabled={issuesLoading}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50 transition-colors font-medium"
            title="كشف الأخطاء غير المنطقية في التفريغ عبر Gemini"
          >
            {issuesLoading ? (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.4 0 0 5.4 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="11" y1="8" x2="11" y2="12" />
                <line x1="11" y1="15" x2="11.01" y2="15" />
              </svg>
            )}
            كشف الأخطاء
          </button>

          {/* زر الإعدادات */}
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 rounded-lg text-muted hover:text-foreground hover:bg-surface-hover transition-colors"
            title="الإعدادات — مفاتيح API"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>

          {/* زر تصدير JSON (سريع) */}
          <button
            onClick={() => {
              const exportData = {
                video: video.path,
                excludedRanges,
                words: words.filter((w) => w.deleted).map((w) => ({
                  word: w.word,
                  start: w.start,
                  end: w.end,
                })),
                stats: {
                  originalDuration,
                  excludedDuration,
                  finalDuration: originalDuration - excludedDuration,
                  deletedWords: deletedCount,
                },
                exportedAt: new Date().toISOString(),
              };
              const blob = new Blob([JSON.stringify(exportData, null, 2)], {
                type: "application/json",
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${video.file_name}_edit_data.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground px-3 py-1.5 rounded-lg hover:bg-surface-hover transition-colors"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            JSON
          </button>

          {/* زر التصدير الكامل */}
          <button
            onClick={() => setShowExportPanel(!showExportPanel)}
            className={`flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-lg font-bold transition-colors ${
              showExportPanel
                ? "bg-accent text-white"
                : "bg-primary text-white hover:bg-primary-hover"
            }`}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {showExportPanel ? "إغلاق" : "تصدير + Shorts"}
          </button>
        </div>
      </header>

      {/* ═══ المنطقة الرئيسية ═══ */}
      <div className="flex flex-1 overflow-hidden">
        {/* مشغل الفيديو */}
        <div className="flex flex-col border-l border-border flex-[1.3] min-w-0 transition-all duration-300">
          {videoUrl ? (
            <VideoPlayer
              videoSrc={videoUrl}
              excludedRanges={excludedRanges}
              onTimeUpdate={handleTimeUpdate}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted text-sm">
              ... جاري تحميل الفيديو
            </div>
          )}
        </div>

        {/* محرر النصوص */}
        <div className="flex flex-col flex-1 min-w-0 transition-all duration-300">
          <TextEditor
            words={words}
            selectedIds={selectedIds}
            playingWordId={playingWordId}
            markedWords={markedWords}
            onSelectionChange={setSelectedIds}
            onToggleDelete={handleToggleDelete}
            onEditWord={handleEditWord}
            onSeekToWord={(time) => {
              const videoEl = document.querySelector("video");
              if (videoEl) {
                const excluded = excludedRanges.find(
                  (r) => time >= r.start && time < r.end
                );
                videoEl.currentTime = excluded ? excluded.end : time;
              }
            }}
          />
        </div>

        {/* شريط كشف الأخطاء المثبّت بجانب المحرر */}
        {showIssues && (
          <div className="w-[340px] shrink-0 border-l border-r border-border overflow-hidden">
            <IssuesPanel
              issues={issues}
              loading={issuesLoading}
              error={issuesError}
              onSeek={seekTo}
              onAccept={handleAcceptIssue}
              onIgnore={handleIgnoreIssue}
              onClose={() => setShowIssues(false)}
            />
          </div>
        )}

        {/* لوحة التصدير (منزلقة من اليسار في RTL) */}
        {showExportPanel && (
          <div className="w-[360px] shrink-0 overflow-y-auto bg-background border-r border-border">
            <ExportPanel
              videoPath={video.path}
              excludedRanges={excludedRanges}
              transcription={transcription}
              words={words}
              deletedCount={deletedCount}
              silenceCount={silenceRanges.length}
              onOpenSettings={() => setShowSettings(true)}
            />
          </div>
        )}
      </div>

      {/* ═══ شريط الحالة السفلي ═══ */}
      <footer className="flex items-center justify-between px-4 py-1.5 bg-surface border-t border-border text-[10px] text-muted shrink-0">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-primary" /> الوقت: {formatTimeShort(currentTime)}
          </span>
          {excludedRanges.length > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-danger/60" /> {excludedRanges.length} مقطع محذوف
            </span>
          )}
        </div>
        <div>
          اللغة: {transcription.language.toUpperCase()} · Space = تشغيل/إيقاف · Del = حذف · Ctrl+Z = تراجع
        </div>
      </footer>

      {/* ═══ نافذة الإعدادات ═══ */}
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  لوحة نتائج كشف الأخطاء
// ═══════════════════════════════════════════════════════════════

function IssuesPanel({
  issues,
  loading,
  error,
  onSeek,
  onAccept,
  onIgnore,
  onClose,
}: {
  issues: TranscriptIssue[] | null;
  loading: boolean;
  error: string | null;
  onSeek: (time: number) => void;
  onAccept: (index: number) => void;
  onIgnore: (index: number) => void;
  onClose: () => void;
}) {
  const severityStyle = (sev: string) => {
    switch (sev) {
      case "high":
        return { chip: "bg-danger/20 text-danger", label: "خطورة عالية" };
      case "low":
        return { chip: "bg-muted/20 text-muted", label: "خطورة منخفضة" };
      default:
        return { chip: "bg-accent/20 text-accent", label: "خطورة متوسطة" };
    }
  };

  return (
    <aside className="flex flex-col h-full bg-surface" dir="rtl">
        {/* رأس */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
            <svg className="w-4 h-4 text-accent shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            كشف الأخطاء
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* المحتوى */}
        <div className="flex-1 px-4 py-3 overflow-y-auto space-y-3">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-10 text-muted text-sm">
              <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.4 0 0 5.4 0 12h4z" />
              </svg>
              يحلّل النموذج التفريغ...
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg bg-danger/10 border border-danger/30 text-sm text-danger whitespace-pre-wrap break-words max-h-64 overflow-y-auto" dir="ltr">
              ❌ {error}
            </div>
          )}

          {!loading && !error && issues && issues.length === 0 && (
            <div className="text-center py-10 text-success text-sm">
              ✅ لم يُعثر على أخطاء واضحة — التفريغ يبدو منطقياً.
            </div>
          )}

          {!loading && issues && issues.map((issue, i) => {
            const s = severityStyle(issue.severity);
            return (
              <div
                key={i}
                className="p-3 rounded-lg bg-background border border-border"
              >
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${s.chip}`}>
                    {s.label}
                  </span>
                  <button
                    onClick={() => onSeek(issue.start)}
                    className="text-[10px] font-mono text-muted hover:text-accent transition-colors"
                    dir="ltr"
                    title="انتقل إلى الموضع في الفيديو"
                  >
                    {formatTimeShort(issue.start)} → {formatTimeShort(issue.end)}
                  </button>
                </div>

                {/* المشبوه → الاقتراح */}
                <div className="flex items-center flex-wrap gap-1.5 mb-1.5">
                  <span className="text-sm text-danger/80 line-through">{issue.text}</span>
                  {issue.suggestion && (
                    <>
                      <span className="text-muted text-xs">←</span>
                      <span className="text-sm text-success font-bold">{issue.suggestion}</span>
                    </>
                  )}
                </div>

                <p className="text-xs text-muted mb-2.5">💡 {issue.reason}</p>

                {/* أزرار القبول / التجاهل */}
                <div className="flex items-center gap-2">
                  {issue.suggestion && (
                    <button
                      onClick={() => onAccept(i)}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-success/15 text-success text-xs font-bold hover:bg-success/25 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      قبول التصحيح
                    </button>
                  )}
                  <button
                    onClick={() => onIgnore(i)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-hover text-muted text-xs font-medium hover:text-foreground transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                    تجاهل
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* تذييل */}
        {!loading && issues && issues.length > 0 && (
          <div className="px-4 py-2.5 border-t border-border text-[11px] text-muted shrink-0">
            {issues.length} موضع مشبوه — «قبول» يطبّق التصحيح بنفس التوقيت.
          </div>
        )}
    </aside>
  );
}

// ═══════════════════════════════════════════════════════════════
//  مكوّنات مساعدة
// ═══════════════════════════════════════════════════════════════

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <div className="flex flex-col items-center">
      <span className={`font-bold ${color}`}>{value}</span>
      <span className="text-muted/60">{label}</span>
    </div>
  );
}
