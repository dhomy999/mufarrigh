"use client";

/**
 * ═══════════════════════════════════════════════════════════════
 *  TextStudio.tsx
 *  استوديو مسار النصّ — يعرض التفريغ كمستند مقروء فوق نفس المخزن
 *  (TranscriptDocument) الذي يقرؤه VideoStudio.
 *
 *  المرحلة ١ (الفصل الهيكلي): سطح منفصل بلا عناصر الفيديو (لا Shorts،
 *  لا تصدير MP4). المحرّر والمشغّل بنيتان مشتركتان. ميزات النصّ الغنية
 *  (تقسيم الفقرات، التصدير DOCX…) تأتي في المرحلة ٢.
 *
 *  قاعدة: «أخفِ ولا تُعطِّل» — لا يرى مفرّغ النصّ أي عنصر لا يخصّه.
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import VideoPlayer from "./VideoPlayer";
import TextEditor from "./TextEditor";
import SettingsModal from "./SettingsModal";
import DictionaryManager from "./DictionaryManager";
import SpeakersPanel from "./SpeakersPanel";
import {
  generateParagraphHeadings,
  type ParagraphInput,
  type HeadingSuggestion,
  exportDocx,
} from "@/lib/tauri-api";
import { buildDocx, type DocxOptions } from "@/core/export/docx";
import {
  type TranscriptDocument,
  type DictionaryEntry,
  genDictId,
} from "@/core/document";
import {
  matchVerses,
  formatVerseRef,
  type VerseMatch,
} from "@/core/religion/quran";
import type { TranscriptionResult, VideoInfo } from "@/lib/tauri-api";
import { useSettings } from "@/lib/settings";
import type { WordState, ExcludedRange } from "@/lib/editor-utils";
import {
  deletedWordsToRanges,
  mergeRanges,
  totalExcludedDuration,
  formatTimeShort,
} from "@/lib/editor-utils";
import { useUndoable } from "@/hooks/useUndoable";

interface TextStudioProps {
  /** المصدر: صوت أو فيديو (نفس بنية VideoInfo) */
  video: VideoInfo;
  transcription: TranscriptionResult;
  initialWords?: WordState[];
  onWordsChange?: (words: WordState[]) => void;
  onExit: () => void;
  /** مبدّل المسار: حوّل إلى مسار الفيديو (نفس البيانات) — plan.md §3.2 */
  onSwitchMode?: () => void;
  /**
   * المستند الموحّد (plan.md §2.4): يُمرَّر لاستخدام فقراته وعناوينه في
   * العرض المتدفّق. غيابها = عرض متواصل بدون فقرات.
   */
  doc?: TranscriptDocument | null;
  /** يُستدعى عند تغيّر قاموس المشروع كي يحفظه الأب في المستند */
  onProjectDictChange?: (entries: DictionaryEntry[]) => void;
  /** يُستدعى عند تغيّر أسماء المتحدثين */
  onSpeakersChange?: (speakers: Record<string, string>) => void;
}

export default function TextStudio({
  video,
  transcription,
  initialWords,
  onWordsChange,
  onExit,
  onSwitchMode,
  doc,
  onProjectDictChange,
  onSpeakersChange,
}: TextStudioProps) {
  const { settings } = useSettings();
  // ─── كلمات المحرر مع تاريخ التراجع/الإعادة ──────────────────
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
  const [showSettings, setShowSettings] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [docxOptions, setDocxOptions] = useState<DocxOptions>({
    titlePage: true,
    toc: true,
    timestamps: false,
  });

  // ─── قاموس المشروع + تعلّم التصحيحات (plan.md §3.1, §3.2) ──────
  const [projectDict, setProjectDict] = useState<DictionaryEntry[]>(
    () => doc?.dictionary ?? []
  );
  // مزامنة الحالة إلى المستند الموحّد عبر callback (لا نُعدّل prop مباشرة)
  useEffect(() => {
    onProjectDictChange?.(projectDict);
  }, [projectDict, onProjectDictChange]);
  const [showProjectDict, setShowProjectDict] = useState(false);
  const [showSpeakers, setShowSpeakers] = useState(false);
  const [correctionSuggestion, setCorrectionSuggestion] = useState<{
    wordId: number;
    from: string;
    to: string;
  } | null>(null);

  // ─── اقتراح العناوين (plan.md §3.3) ──────────────────────────
  const [suggestingHeadings, setSuggestingHeadings] = useState(false);
  const [headingSuggestions, setHeadingSuggestions] = useState<HeadingSuggestion[]>([]);
  const [headingStatus, setHeadingStatus] = useState<string | null>(null);

  // ─── كشف الآيات القرآنية (plan.md §3.4) ──────────────────────
  // يُعاد احتسابه تلقائياً عند تغيّر التوكِنات.
  const verseMatches: VerseMatch[] = useMemo(() => {
    if (!doc) return [];
    return matchVerses(doc.tokens);
  }, [doc]);

  // ─── خيارات تصدير DOCX ──────────────────────────────────────
  const updateDocxOption = useCallback(
    <K extends keyof DocxOptions>(k: K, v: DocxOptions[K]) =>
      setDocxOptions((p) => ({ ...p, [k]: v })),
    []
  );

  const handleSuggestHeadings = useCallback(async () => {
    if (!doc) return;
    const headingModel = settings.tasks.detectIssues; // نستخدم نموذج المهام النصية
    const entry = settings.models.find((m) => m.id === headingModel.modelId);
    if (!entry || !entry.apiKey) {
      setHeadingStatus("اختر نموذجاً نصياً وأضف مفتاحه من الإعدادات");
      setTimeout(() => setHeadingStatus(null), 4000);
      return;
    }
    setSuggestingHeadings(true);
    setHeadingSuggestions([]);
    setHeadingStatus(null);
    try {
      const inputs: ParagraphInput[] = doc.paragraphs.map((p) => {
        const s = doc.tokens.findIndex((t) => t.id === p.startTokenId);
        const e = doc.tokens.findIndex((t) => t.id === p.endTokenId);
        const text = doc.tokens
          .slice(Math.max(0, s), e + 1)
          .filter((t) => t.kind === "word" && t.status !== "removed")
          .map((t) => t.text)
          .join(" ");
        return { startTokenId: p.startTokenId, endTokenId: p.endTokenId, text };
      });
      const sug = await generateParagraphHeadings(
        inputs,
        entry.apiKey,
        entry.provider,
        entry.model,
        "ar"
      );
      setHeadingSuggestions(sug);
      setHeadingStatus(`اقتُرح ${sug.length} عنواناً — راجعها أدناه`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setHeadingStatus(`فشل الاقتراح: ${msg}`);
    } finally {
      setSuggestingHeadings(false);
      setTimeout(() => setHeadingStatus(null), 6000);
    }
  }, [doc, settings]);

  const handleApplyHeadings = useCallback(() => {
    if (!doc || headingSuggestions.length === 0) return;
    for (const sug of headingSuggestions) {
      const p = doc.paragraphs.find((x) => x.startTokenId === sug.beforeTokenId);
      if (p) p.heading = sug.heading;
    }
    // إعادة تصيير بإجبار تحديث المفتاح (state)
    setProjectDict((d) => [...d]); // تحريك إعادة التصيير
    setHeadingSuggestions([]);
    setHeadingStatus("تم تطبيق العناوين على المستند");
    setTimeout(() => setHeadingStatus(null), 4000);
  }, [doc, headingSuggestions]);

  const handleDismissHeadings = useCallback(() => {
    setHeadingSuggestions([]);
    setHeadingStatus(null);
  }, []);

  const handleExportDocx = useCallback(async () => {
    if (!doc || exporting) return;
    setExporting(true);
    setExportStatus(null);
    try {
      const blob = await buildDocx(doc, {
        ...docxOptions,
        title: video.file_name,
        verseMatches, // تُنسَّق بـ ﴿ ﴾ + اسم السورة ورقم الآية (plan.md §3.4)
      });
      const buf = new Uint8Array(await blob.arrayBuffer());
      const safeName = video.file_name.replace(/[\\/:*?"<>|]/g, "_");
      const path = await exportDocx(buf, `${safeName}.docx`);
      setExportStatus(path ? `تم الحفظ: ${path}` : "تم الإلغاء");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setExportStatus(`فشل التصدير: ${msg}`);
    } finally {
      setExporting(false);
      setTimeout(() => setExportStatus(null), 5000);
    }
  }, [doc, docxOptions, video.file_name, exporting, verseMatches]);

  // ─── تحويل مسار المصدر لرابط قابل للتشغيل ────────────────────
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

  // ─── الفترات المحذوفة = الكلمات المحذوفة فقط (لا سكتات في مسار النصّ) ──
  const excludedRanges: ExcludedRange[] = useMemo(
    () => mergeRanges(deletedWordsToRanges(words)),
    [words]
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

  // ─── معالجات التحرير ────────────────────────────────────────
  const handleToggleDelete = useCallback((ids: number[]) => {
    setWords((prev) =>
      prev.map((w) => (ids.includes(w.id) ? { ...w, deleted: !w.deleted } : w))
    );
  }, [setWords]);

  const handleEditWord = useCallback(
    (id: number, newText: string) => {
      setWords((prev) => {
        const prevWord = prev[id];
        if (!prevWord || prevWord.word === newText) return prev;
        return prev.map((w) =>
          w.id === id ? { ...w, word: newText, edited: true } : w
        );
      });
      // تعلَّم من تصحيحاتي (plan.md §3.2): إن كانت هذه الكلمة تصحيحاً
      // لـ ASR، اقترح إضافتها للقاموس.
      const original = doc?.tokens[id]?.originalText;
      const prevWord = words[id];
      if (original && prevWord && original !== newText) {
        const source = prevWord.edited ? prevWord.word : original;
        if (source !== newText) {
          setCorrectionSuggestion({ wordId: id, from: source, to: newText });
        }
      }
    },
    [setWords, words, doc]
  );

  const acceptCorrection = useCallback(() => {
    if (!correctionSuggestion) return;
    const entry: DictionaryEntry = {
      id: genDictId(),
      match: correctionSuggestion.from,
      replacement: correctionSuggestion.to,
      kind: "text",
      note: "تعلَّم من تصحيحاتي",
    };
    setProjectDict((d) => {
      // لا تُضف مكرّراً
      if (d.some((x) => x.match === entry.match && x.replacement === entry.replacement)) return d;
      return [...d, entry];
    });
    setCorrectionSuggestion(null);
  }, [correctionSuggestion]);

  const dismissCorrection = useCallback(() => setCorrectionSuggestion(null), []);

  const handleTimeUpdate = useCallback((time: number) => {
    setCurrentTime(time);
  }, []);

  // ─── اختصارات لوحة المفاتيح ────────────────────────────────────
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const inField = (e.target as HTMLElement)?.matches(
        "input, textarea, select"
      );
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

          {/* تراجع / إعادة */}
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

          <h1 className="text-sm font-bold text-foreground">مسار النصّ</h1>
          <span className="text-xs text-muted truncate max-w-[200px]">
            {video.file_name}
          </span>
        </div>

        {/* إحصائيات */}
        <div className="flex items-center gap-4 text-xs">
          <Stat label="كلمات" value={activeCount} color="text-foreground" />
          <Stat label="محذوفة" value={deletedCount} color="text-danger" />
          <Stat
            label="المدة"
            value={formatTimeShort(originalDuration - excludedDuration)}
            color="text-success"
          />
        </div>

        <div className="flex items-center gap-2">
          {/* قاموس المشروع (plan.md §3.1) */}
          <button
            onClick={() => setShowProjectDict(true)}
            title="قاموس هذا المشروع — يُطبَّق بعد التفريغ ويُحفظ معه"
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-surface-hover text-foreground hover:bg-border transition-colors font-medium"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            قاموس المشروع ({projectDict.length})
          </button>

          {/* المتحدثون (plan.md §5.1) */}
          <button
            onClick={() => setShowSpeakers(true)}
            title="لوحة تسمية المتحدثين (الفصل الآلي مؤجَّل)"
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-surface-hover text-foreground hover:bg-border transition-colors font-medium"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            المتحدثون
          </button>

          {/* اقتراح عناوين (plan.md §3.3) */}
          <button
            onClick={handleSuggestHeadings}
            disabled={suggestingHeadings || !doc}
            title="تمريرة عناوين بالنموذج (§5.2) — آمنة، لا تلمس الكلمات"
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-surface-hover text-foreground hover:bg-border disabled:opacity-40 transition-colors font-medium"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 4h12" />
              <path d="M6 8h12" />
              <path d="M6 12h8" />
            </svg>
            {suggestingHeadings ? "يقترح…" : "اقتراح عناوين"}
          </button>

          {/* تصدير DOCX (plan.md §2.6) */}
          <div className="flex items-center gap-1.5 bg-surface-hover rounded-lg px-2 py-1 text-[11px]">
            <label className="flex items-center gap-1 text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={docxOptions.titlePage ?? true}
                onChange={(e) => updateDocxOption("titlePage", e.target.checked)}
                className="accent-primary"
              />
              غلاف
            </label>
            <label className="flex items-center gap-1 text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={docxOptions.timestamps ?? false}
                onChange={(e) => updateDocxOption("timestamps", e.target.checked)}
                className="accent-primary"
              />
              طوابع زمنية
            </label>
            <button
              onClick={handleExportDocx}
              disabled={exporting || !doc}
              title="تصدير Word (DOCX) — مع RTL صحيح"
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary text-white hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              {exporting ? "جاري التصدير…" : "تصدير DOCX"}
            </button>
          </div>
          {/* مبدّل المسار (plan.md §3.2) */}
          {onSwitchMode && (
            <button
              onClick={onSwitchMode}
              title="حوّل إلى مسار الفيديو (نفس البيانات)"
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-surface-hover text-foreground hover:bg-border transition-colors font-medium"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                <line x1="7" y1="2" x2="7" y2="22" />
                <line x1="17" y1="2" x2="17" y2="22" />
                <line x1="2" y1="12" x2="22" y2="12" />
              </svg>
              مسار الفيديو
            </button>
          )}

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
        </div>
      </header>

      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />

      {showProjectDict && (
        <DictionaryManager
          title="قاموس المشروع"
          entries={projectDict}
          onChange={setProjectDict}
          onClose={() => setShowProjectDict(false)}
        />
      )}

      {showSpeakers && (
        <SpeakersPanel
          doc={doc!}
          onSpeakersChange={onSpeakersChange ?? (() => {})}
          onClose={() => setShowSpeakers(false)}
        />
      )}

      {/* ═══ المنطقة الرئيسية ═══ */}
      <div className="flex flex-1 overflow-hidden">
        {/* المشغّل (صوت/فيديو) — يُشارك مع مسار الفيديو */}
        <div className="flex flex-col border-l border-border w-[380px] shrink-0 min-w-0">
          {videoUrl ? (
            <VideoPlayer
              videoSrc={videoUrl}
              excludedRanges={excludedRanges}
              onTimeUpdate={handleTimeUpdate}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted text-sm">
              ... جاري تحميل المصدر
            </div>
          )}
        </div>

        {/* المحرّر — يُقرأ كمستند */}
        <div className="flex flex-col flex-1 min-w-0">
          <TextEditor
            words={words}
            selectedIds={selectedIds}
            playingWordId={playingWordId}
            paragraphs={doc?.paragraphs}
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
      </div>

      {/* ═══ نافذة اقتراح التصحيح (تعلَّم من تصحيحاتي — §3.2) ═══ */}
      {correctionSuggestion && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-40 bg-surface border border-primary/40 shadow-2xl rounded-xl px-4 py-3 flex items-center gap-3 max-w-xl">
          <span className="text-sm text-foreground">هل تريد إضافة هذا التصحيح للقاموس؟</span>
          <code className="px-1.5 py-0.5 rounded bg-background text-foreground text-xs">
            {correctionSuggestion.from}
          </code>
          <span className="text-muted">←</span>
          <code className="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-xs">
            {correctionSuggestion.to}
          </code>
          <div className="flex items-center gap-1.5">
            <button
              onClick={acceptCorrection}
              className="px-3 py-1 text-xs font-bold rounded-md bg-primary text-white hover:bg-primary-hover transition-colors"
            >
              نعم، أضِفه
            </button>
            <button
              onClick={dismissCorrection}
              className="px-3 py-1 text-xs rounded-md text-muted hover:text-foreground hover:bg-surface-hover transition-colors"
            >
              لا
            </button>
          </div>
        </div>
      )}

      {/* ═══ لوحة الآيات القرآنية المكتشفة (§3.4) ═══ */}
      {verseMatches.length > 0 && (
        <details className="mx-4 mb-2 rounded-xl bg-success/5 border border-success/30 group">
          <summary className="px-3 py-2 cursor-pointer text-sm font-bold text-success flex items-center justify-between">
            <span>✨ آيات قرآنية مكتشفة ({verseMatches.length})</span>
            <span className="text-[10px] text-muted">انقر للعرض</span>
          </summary>
          <ul className="px-3 pb-2 space-y-1 max-h-40 overflow-y-auto">
            {verseMatches.map((v, i) => (
              <li
                key={i}
                className="flex items-center justify-between text-xs px-2 py-1 rounded bg-background/70"
                dir="rtl"
              >
                <span className="text-foreground">{formatVerseRef(v)}</span>
                <span className="text-muted text-[10px] tabular-nums" dir="ltr">
                  {Math.round(v.score * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* ═══ لوحة اقتراح العناوين (§3.3) ═══ */}
      {headingSuggestions.length > 0 && (
        <div className="mx-4 mb-2 p-3 rounded-xl bg-surface border border-border">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-bold text-foreground">
              اقتراحات العناوين ({headingSuggestions.length})
            </h3>
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleDismissHeadings}
                className="px-2 py-1 text-xs text-muted hover:text-foreground rounded hover:bg-surface-hover"
              >
                تجاهل
              </button>
              <button
                onClick={handleApplyHeadings}
                className="px-3 py-1 text-xs font-bold rounded-md bg-primary text-white hover:bg-primary-hover"
              >
                طبّق على المستند
              </button>
            </div>
          </div>
          <ul className="space-y-1 max-h-40 overflow-y-auto">
            {headingSuggestions.map((s, i) => (
              <li
                key={i}
                className="text-xs px-2 py-1 rounded bg-background text-foreground"
                dir="rtl"
              >
                <span className="text-muted text-[10px] ml-2">{s.beforeTokenId}</span>
                <span className="font-medium">{s.heading}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ═══ شريط الحالة السفلي ═══ */}
      <footer className="flex items-center justify-between px-4 py-1.5 bg-surface border-t border-border text-[10px] text-muted shrink-0">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-primary" /> الوقت: {formatTimeShort(currentTime)}
          </span>
          {verseMatches.length > 0 && (
            <span className="text-success/90">
              ✨ {verseMatches.length} آية مكتشفة
            </span>
          )}
          {exportStatus && (
            <span className="text-primary/80">{exportStatus}</span>
          )}
          {headingStatus && (
            <span className="text-primary/80">{headingStatus}</span>
          )}
        </div>
        <div>
          مسار النصّ · Space = تشغيل/إيقاف · Del = حذف · Ctrl+Z = تراجع
        </div>
      </footer>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-muted">{label}</span>
      <span className={`font-bold tabular-nums ${color}`}>{value}</span>
    </span>
  );
}
