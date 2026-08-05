"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import {
  pickVideoFile,
  pickMediaFile,
  extractAudio,
  checkFFmpegAvailable,
  detectSilence,
  transcribeAudio,
  cancelTranscription,
  exportProjectFile,
  importProjectFile,
  formatTime,
  type VideoInfo,
  type AudioExtractionResult,
  type SilenceDetectionResult,
  type SilenceSegment,
  type TranscriptionResult,
  type WordTimestamp,
  type AppError,
  type TranscriptionProvider,
  type TranscribeProgress,
} from "@/lib/tauri-api";
import { useSettings, type ProjectMode } from "@/lib/settings";
import type { ExcludedRange, WordState } from "@/lib/editor-utils";
import {
  projectIdForVideo,
  saveProject,
  listProjects,
  loadProject,
  deleteProject,
  type ProjectMeta,
  type ProjectEnvelope,
} from "@/lib/project";
import {
  transcriptionToDocument,
  syncDocumentFromWordState,
  documentToTranscription,
  tokensToWordState,
  alignWordsToText,
  applyParagraphs,
  applyDictionary,
  buildAdditionalVocab,
  applyToText,
  type TranscriptDocument,
} from "@/core/document";
import SettingsModal from "@/components/SettingsModal";

// تحميل ديناميكي للاستوديوين (يحتاج window — لا يعمل في SSR)
const VideoStudio = dynamic(() => import("@/components/VideoStudio"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-screen text-muted">
      ... جاري تحميل الاستوديو
    </div>
  ),
});
const TextStudio = dynamic(() => import("@/components/TextStudio"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-screen text-muted">
      ... جاري تحميل الاستوديو
    </div>
  ),
});

// ═══════════════════════════════════════════════════════════════
//  أيقونات SVG
// ═══════════════════════════════════════════════════════════════

const Icon = {
  Upload: () => (<svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>),
  Music: () => (<svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>),
  Check: () => (<svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>),
  Alert: () => (<svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>),
  Film: () => (<svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" /><line x1="2" y1="17" x2="7" y2="17" /><line x1="17" y1="17" x2="22" y2="17" /><line x1="17" y1="7" x2="22" y2="7" /></svg>),
  Spinner: () => (<svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none" strokeWidth="3"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" /></svg>),
  VolumeOff: () => (<svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>),
  Mic: () => (<svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></svg>),
  Trash: () => (<svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>),
  Doc: () => (<svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>),
  Play: () => (<svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>),
  Pause: () => (<svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>),
};

// ═══════════════════════════════════════════════════════════════
//  الصفحة الرئيسية
// ═══════════════════════════════════════════════════════════════

type Stage = "pick" | "extracted" | "silence" | "transcribed";

/** هل المسار ملف صوتي؟ (لمسار النصّ — تخطّي الاستخراج وتحديد sourceKind) */
function isAudioPath(path: string): boolean {
  return /\.(mp3|wav|m4a|aac|ogg|flac|wma|opus|oga)$/i.test(path);
}

export default function Home() {
  // المرحلة 1
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [audioResult, setAudioResult] = useState<AudioExtractionResult | null>(null);
  const [ffmpegOk, setFFmpegOk] = useState<boolean | null>(null);
  const [stage, setStage] = useState<Stage>("pick");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  // المرحلة 2 — السكتات
  const [silence, setSilence] = useState<SilenceDetectionResult | null>(null);
  const [removedSegments, setRemovedSegments] = useState<Set<number>>(new Set());
  const [noiseDb, setNoiseDb] = useState(-30);
  const [minDur, setMinDur] = useState(0.5);

  // معاينة صوتية للسكتات (قبل الاستوديو)
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const stopTimerRef = useRef<number | null>(null);

  // المرحلة 2 — التفريغ
  const [transcription, setTranscription] = useState<TranscriptionResult | null>(null);
  const [provider, setProvider] = useState<TranscriptionProvider>("groq");
  // تقدّم التفريغ (إلغاء + تقسيم الملفات الطويلة — plan.md §0.2/§0.3)
  const [transcribeProgress, setTranscribeProgress] = useState<TranscribeProgress | null>(null);

  // مسار المشروع: نصّي (افتراضي) أو فيديو (plan.md §3)
  const [mode, setMode] = useState<ProjectMode>("text");

  // الإعدادات المركزية (مفاتيح + موديلات)
  const { settings } = useSettings();
  const [showSettings, setShowSettings] = useState(false);
  const [projectIoStatus, setProjectIoStatus] = useState<string | null>(null);

  // المرحلة 3 — الاستوديو
  const [studioMode, setStudioMode] = useState(false);

  // المرحلة 5 — المشاريع المحفوظة
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  // كلمات المحرر بحالتها الأخيرة — تبقى محفوظة عبر خروج/دخول الاستوديو
  const [studioWords, setStudioWords] = useState<WordState[] | null>(null);
  // المستند الموحّد (تدفّق توكِنات) — مصدر الحقيقة للحفظ. يُحدَّث من studioWords.
  const docRef = useRef<TranscriptDocument | null>(null);

  useEffect(() => {
    checkFFmpegAvailable().then(setFFmpegOk);
    listProjects().then(setProjects).catch(() => {});
  }, []);

  // ─── تحويل مسار الصوت المستخرج لرابط قابل للتشغيل (للمعاينة) ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!audioResult) {
        if (!cancelled) setAudioUrl("");
        return;
      }
      try {
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        if (!cancelled) setAudioUrl(convertFileSrc(audioResult.output_path));
      } catch {
        if (!cancelled) setAudioUrl(`file://${audioResult.output_path}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [audioResult]);

  // تنظيف مؤقّت الإيقاف عند إزالة المكوّن
  useEffect(() => {
    return () => {
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    };
  }, []);

  // ─── معالجات المرحلة 1 ──────────────────────────────────

  const handlePick = useCallback(async () => {
    setBusy("pick");
    setError("");
    try {
      // مسار النصّ يقبل صوتاً أو فيديو؛ مسار الفيديو فيديو فقط
      const info = await (mode === "text" ? pickMediaFile() : pickVideoFile());
      if (info) {
        setVideo(info);
        setAudioResult(null);
        setSilence(null);
        setRemovedSegments(new Set());
        setTranscription(null);
        setStudioWords(null);
        docRef.current = null;
        // مصدر صوتي → لا حاجة للاستخراج، نتعامل مع الملف مباشرة
        const audio = /\.(mp3|wav|m4a|aac|ogg|flac|wma|opus|oga)$/i.test(info.path);
        if (audio) {
          setAudioResult({
            success: true,
            output_path: info.path,
            message: "ملف صوتي — لا حاجة للاستخراج",
            output_size_mb: info.file_size_mb,
          });
          setStage("extracted");
        } else {
          setStage("pick");
        }
      }
    } catch (e) {
      setError((e as AppError).message);
    } finally {
      setBusy(null);
    }
  }, [mode]);

  const handleExtract = useCallback(async () => {
    if (!video) return;
    setBusy("extract");
    setError("");
    try {
      const res = await extractAudio(video.path);
      setAudioResult(res);
      setStage("extracted");
    } catch (e) {
      setError((e as AppError).message);
    } finally {
      setBusy(null);
    }
  }, [video]);

  // ─── معالجات المرحلة 2: السكتات ──────────────────────────

  const handleDetectSilence = useCallback(async () => {
    if (!audioResult) return;
    setBusy("silence");
    setError("");
    setRemovedSegments(new Set());
    try {
      const res = await detectSilence(audioResult.output_path, noiseDb, minDur);
      setSilence(res);
      // كل السكتات المكتشفة محددة للحذف افتراضياً —
      // «تراجع» على أي سكتة تريد إبقاءها
      setRemovedSegments(new Set(res.segments.map((_, i) => i)));
      setStage("silence");
    } catch (e) {
      setError((e as AppError).message);
    } finally {
      setBusy(null);
    }
  }, [audioResult, noiseDb, minDur]);

  const handleRemoveSegment = useCallback((idx: number) => {
    setRemovedSegments((prev) => new Set([...prev, idx]));
  }, []);

  const handleRestoreSegment = useCallback((idx: number) => {
    setRemovedSegments((prev) => {
      const next = new Set(prev);
      next.delete(idx);
      return next;
    });
  }, []);

  const handleSelectAllSegments = useCallback(() => {
    if (!silence) return;
    setRemovedSegments(new Set(silence.segments.map((_, i) => i)));
  }, [silence]);

  const handleClearAllSegments = useCallback(() => {
    setRemovedSegments(new Set());
  }, []);

  // ─── معاينة صوتية لسكتة واحدة ────────────────────────────
  // نشغّل السكتة بالضبط من بدايتها إلى نهايتها بلا أي هامش،
  // حتى تسمع تماماً ما كُشف كسكتة وتحكم على دقة الكشف.
  const handlePreviewSegment = useCallback(
    (idx: number, seg: SilenceSegment) => {
      const audio = audioRef.current;
      if (!audio) return;

      // إلغاء أي مؤقّت إيقاف سابق
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      }

      // إذا كان نفس المقطع يُشغّل حالياً → أوقفه (زر Toggle)
      if (previewIdx === idx && !audio.paused) {
        audio.pause();
        setPreviewIdx(null);
        return;
      }

      // تشغيل دقيق بلا هوامش: من seg.start إلى seg.end بالضبط
      audio.currentTime = seg.start;
      audio.play().catch(() => {});
      setPreviewIdx(idx);

      const durationMs = Math.max(0, (seg.end - seg.start) * 1000);
      stopTimerRef.current = window.setTimeout(() => {
        audio.pause();
        setPreviewIdx(null);
        stopTimerRef.current = null;
      }, durationMs);
    },
    [previewIdx]
  );

  // ─── معالجات المرحلة 2: التفريغ ──────────────────────────

  const handleTranscribe = useCallback(async () => {
    if (!audioResult) return;
    const apiKey = settings.keys[provider];
    if (!apiKey) {
      setError(`أضف مفتاح ${provider} من الإعدادات أولاً`);
      setShowSettings(true);
      return;
    }
    setBusy("transcribe");
    setError("");
    setTranscribeProgress({
      stage: "preparing",
      chunk_index: 0,
      chunk_total: 1,
      percent: 0,
      message: "تجهيز التفريغ...",
    });

    // الاشتراك في أحداث التقدّم القادمة من الخلفية
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<TranscribeProgress>("transcribe-progress", (e) => {
      setTranscribeProgress(e.payload);
    });

    try {
      // قاموس موحّد: عام + خاص بالمشروع (plan.md §3.1) — يُحقَن في additional_vocab قبل التفريغ
      const allEntries = [
        ...(settings.dictionary ?? []),
        ...(docRef.current?.dictionary ?? []),
      ];
      const vocabForProvider = provider === "speechmatics" ? buildAdditionalVocab(allEntries) : undefined;

      const raw = await transcribeAudio(
        audioResult.output_path,
        apiKey,
        provider,
        settings.transcriptionModels[provider],
        undefined,
        vocabForProvider
      );
      // التقاط الترقيم المجاني من النص الكامل (plan.md §2.2)
      const res = {
        ...raw,
        words: alignWordsToText(raw.words, raw.full_text),
      };
      setTranscription(res);
      // ابنِ المستند الموحّد من التفريغ الآلي (نواة الحفظ الجديدة)
      docRef.current = transcriptionToDocument(
        res,
        isAudioPath(video?.path ?? "") ? "audio" : "video",
        provider
      );
      // تقسيم الفقرات (plan.md §5)
      applyParagraphs(docRef.current);
      // تطبيق القاموس على الكلمات (post-processing، يعمل مع كل المزوّدين — plan.md §3.1).
      // نطبّقه على res.words حتى يبني الاستوديو كلماته من نصّ مُصحَّح
      // (الاستوديو يسقط في transcription.words قبل أوّل حفظ).
      for (const w of res.words) {
        const next = applyToText(w.word, allEntries);
        if (next !== w.word) w.word = next;
      }
      applyDictionary(docRef.current.tokens, allEntries);
      setStage("transcribed");
    } catch (e) {
      const err = e as AppError;
      // الإلغاء لا يُظهر خطأً — نكتفي بالعودة للحالة السابقة
      if (err.error_type !== "Cancelled") {
        setError(err.message);
      }
    } finally {
      unlisten();
      setBusy(null);
      setTranscribeProgress(null);
    }
  }, [audioResult, settings, provider, video]);

  /** ✋ إلغاء التفريغ الجاري */
  const handleCancelTranscribe = useCallback(async () => {
    try {
      await cancelTranscription();
    } catch {
      /* تجاهل — يكفي أن الخلفية ضبطت العلم */
    }
  }, []);

  // ─── المرحلة ٥.٤: تصدير / استيراد المشروع كملف JSON ──────────────
  const handleExportProject = useCallback(async () => {
    if (!docRef.current) {
      setProjectIoStatus("لا يوجد مشروع لتصديره");
      return;
    }
    try {
      const payload = {
        schemaVersion: 2,
        exportedAt: new Date().toISOString(),
        video,
        doc: docRef.current,
        mode,
      };
      const json = JSON.stringify(payload, null, 2);
      const safeName = (video?.file_name ?? "project").replace(
        /[\\/:*?"<>|]/g,
        "_"
      );
      const path = await exportProjectFile(json, `${safeName}.aravid.json`);
      setProjectIoStatus(path ? `تم التصدير: ${path}` : "تم الإلغاء");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setProjectIoStatus(`فشل التصدير: ${msg}`);
    }
    setTimeout(() => setProjectIoStatus(null), 5000);
  }, [video, mode]);

  const handleImportProject = useCallback(async () => {
    try {
      const json = await importProjectFile();
      if (!json) {
        setProjectIoStatus("تم الإلغاء");
        setTimeout(() => setProjectIoStatus(null), 4000);
        return;
      }
      const payload = JSON.parse(json);
      if (payload.schemaVersion !== 2 || !payload.doc) {
        setProjectIoStatus("ملف غير صالح (schemaVersion v2 مطلوب)");
        setTimeout(() => setProjectIoStatus(null), 5000);
        return;
      }
      // استبدل المستند + أعد بناء التفريغ
      docRef.current = payload.doc as TranscriptDocument;
      const fullText = docRef.current.tokens
        .filter((t) => t.kind === "word" && t.status !== "removed")
        .map((t) => t.text)
        .join(" ");
      setTranscription(documentToTranscription(docRef.current, fullText));
      if (payload.video) setVideo(payload.video as VideoInfo);
      setStudioMode(true);
      setStage("transcribed");
      setProjectIoStatus("تم الاستيراد");
      setTimeout(() => setProjectIoStatus(null), 4000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setProjectIoStatus(`فشل الاستيراد: ${msg}`);
      setTimeout(() => setProjectIoStatus(null), 5000);
    }
  }, []);

  // ─── المرحلة 5: حفظ المشروع تلقائياً ──────────────────────────

  const persistProject = useCallback(async () => {
    // لا يُحفظ مشروع قبل اكتمال التفريغ — قبله لا توجد بيانات مكلفة
    if (!video || !transcription || !docRef.current) return;

    // حدّث توكِنات المستند من حالة المحرّر (إن دخَل الاستوديو)،
    // مع الحفاظ على المعرّفات والنصّ الأصلي. وإن لم يدخل بعد يبقى
    // المستند الأساسي (كل الكلمات نشطة) كما بُني من التفريغ.
    const document = studioWords
      ? syncDocumentFromWordState(docRef.current, studioWords, transcription.words)
      : docRef.current;
    docRef.current = document;

    const envelope: ProjectEnvelope = {
      schemaVersion: 2,
      meta: {
        id: projectIdForVideo(video.path),
        name: video.file_name,
        video_path: video.path,
        video_exists: true, // يُعاد حسابها في الخلفية عند العرض
        updated_at: new Date().toISOString(),
        duration: transcription.duration,
        word_count: (studioWords ?? transcription.words).length,
        deleted_count: studioWords?.filter((w) => w.deleted).length ?? 0,
      },
      data: {
        version: 2,
        mode,
        video,
        audioPath: audioResult?.output_path ?? null,
        noiseDb,
        minDur,
        silence,
        removedSegments: [...removedSegments],
        document,
        fullText: transcription.full_text,
        duration: transcription.duration,
      },
    };

    try {
      await saveProject(envelope);
      listProjects().then(setProjects).catch(() => {});
    } catch (e) {
      // الحفظ التلقائي لا يقاطع عمل المستخدم — يُسجَّل فقط
      console.error("فشل حفظ المشروع:", e);
    }
  }, [video, transcription, audioResult, noiseDb, minDur, silence, removedSegments, studioWords, mode]);

  // حفظ مؤجَّل (1.2s) بعد أي تغيير مهم: تفريغ، سكتات، كلمات المحرر
  useEffect(() => {
    if (!video || !transcription) return;
    const t = window.setTimeout(() => {
      void persistProject();
    }, 1200);
    return () => window.clearTimeout(t);
  }, [video, transcription, persistProject]);

  // ─── فتح مشروع محفوظ: استعادة كل الحالة ──────────────────────
  const handleOpenProject = useCallback(async (id: string) => {
    setBusy("open-project");
    setError("");
    try {
      // loadProject يُرجِع المشروع مُطبَّعاً إلى v2 دائماً (مع ترحيل آمن إن كان قديماً)
      const proj = await loadProject(id);
      const d = proj.data;
      const transcription = documentToTranscription(d.document, d.fullText);
      const words = tokensToWordState(d.document.tokens);
      docRef.current = d.document;
      setMode(d.mode ?? "video");
      setVideo(d.video);
      setAudioResult(
        d.audioPath
          ? {
              success: true,
              output_path: d.audioPath,
              message: "الصوت مستعاد من المشروع المحفوظ",
              output_size_mb: 0,
            }
          : null
      );
      setNoiseDb(d.noiseDb ?? -30);
      setMinDur(d.minDur ?? 0.5);
      setSilence(d.silence ?? null);
      setRemovedSegments(new Set(d.removedSegments ?? []));
      setTranscription(transcription);
      setStudioWords(words.length > 0 ? words : null);
      setStage(
        d.document.tokens.length > 0
          ? "transcribed"
          : d.silence
            ? "silence"
            : d.audioPath
              ? "extracted"
              : "pick"
      );
    } catch (e) {
      setError((e as AppError).message);
    } finally {
      setBusy(null);
    }
  }, []);

  // ─── حذف مشروع من القائمة ────────────────────────────────────
  const handleDeleteProject = useCallback(async (id: string) => {
    try {
      await deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      setError((e as AppError).message);
    }
  }, []);

  const activeSegments = silence?.segments.filter((_, i) => !removedSegments.has(i)) ?? [];
  const removedCount = silence ? removedSegments.size : 0;

  // ─── فترات السكتات المحدَّدة للحذف — تُمرَّر للاستوديو لتُقتطع نهائياً ──
  const silenceRanges = useMemo<ExcludedRange[]>(() => {
    if (!silence) return [];
    return silence.segments
      .filter((_, i) => removedSegments.has(i))
      .map((s) => ({ start: s.start, end: s.end }));
  }, [silence, removedSegments]);

  // ═══ عرض الاستوديو إذا كان مفعّلاً ═══
  if (studioMode && video && transcription) {
    const handleSwitchMode = () =>
      setMode((m) => (m === "text" ? "video" : "text"));
    if (mode === "text") {
      return (
        <TextStudio
          video={video}
          transcription={transcription}
          initialWords={studioWords ?? undefined}
          onWordsChange={setStudioWords}
          onExit={() => setStudioMode(false)}
          onSwitchMode={handleSwitchMode}
          // eslint-disable-next-line react-hooks/refs -- جسر المستند يُحدَّث في handlers
          doc={docRef.current}
          onProjectDictChange={(entries) => {
            if (docRef.current) docRef.current.dictionary = entries;
          }}
          onSpeakersChange={(speakers) => {
            if (docRef.current) docRef.current.speakers = speakers;
          }}
        />
      );
    }
    return (
      <VideoStudio
        video={video}
        transcription={transcription}
        silenceRanges={silenceRanges}
        initialWords={studioWords ?? undefined}
        onWordsChange={setStudioWords}
        onExit={() => setStudioMode(false)}
        onSwitchMode={handleSwitchMode}
      />
    );
  }

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* شريط العنوان */}
      <header className="flex items-center justify-between px-6 py-4 bg-surface border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/20 text-primary">
            <Icon.Film />
          </div>
          <div>
            <h1 className="text-lg font-bold text-foreground">aravid</h1>
            <p className="text-xs text-muted">تفريغ النصّ وتحرير الفيديو — بالعربية</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {projectIoStatus && (
            <span className="text-[11px] text-primary/80 max-w-[260px] truncate" title={projectIoStatus}>
              {projectIoStatus}
            </span>
          )}
          <button
            onClick={handleExportProject}
            // eslint-disable-next-line react-hooks/refs -- الجسر يُحدَّث في handlers
            disabled={!docRef.current}
            title="تصدير المشروع كملف JSON قابل للمشاركة (plan.md §5.4)"
            className="p-2 rounded-lg text-muted hover:text-foreground hover:bg-surface-hover disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
          <button
            onClick={handleImportProject}
            title="استيراد مشروع من ملف JSON (plan.md §5.4)"
            className="p-2 rounded-lg text-muted hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </button>
          {ffmpegOk === null ? (
            <span className="text-muted">... فحص FFmpeg</span>
          ) : ffmpegOk ? (
            <span className="flex items-center gap-1.5 text-success">
              <span className="w-2 h-2 rounded-full bg-success animate-pulse" /> FFmpeg جاهز
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-danger">
              <span className="w-2 h-2 rounded-full bg-danger" /> FFmpeg غير مثبّت
            </span>
          )}
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 rounded-lg text-muted hover:text-foreground hover:bg-surface-hover transition-colors"
            title="الإعدادات — مفاتيح API"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />

      {/* المحتوى */}
      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-5">

          {/* ═══ اختيار المسار (plan.md §3) ═══ */}
          <div className="grid grid-cols-2 gap-3">
            <ModeCard
              active={mode === "text"}
              onClick={() => setMode("text")}
              title="تفريغ نصّي"
              desc="تفريغ المحاضرات والدروس إلى مستند مقروء"
              icon={<Icon.Doc />}
            />
            <ModeCard
              active={mode === "video"}
              onClick={() => setMode("video")}
              title="تحرير فيديو"
              desc="قصّ الفيديو وحذف الأجزاء عبر تحرير النصّ"
              icon={<Icon.Film />}
            />
          </div>

          {/* ═══ المشاريع المحفوظة ═══ */}
          {!video && projects.length > 0 && (
            <div className="bg-surface rounded-2xl border border-border p-5 space-y-3">
              <h2 className="text-sm font-semibold text-muted uppercase tracking-wider flex items-center gap-2">
                <svg className="w-5 h-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                مشاريعك الأخيرة
              </h2>
              <div className="space-y-2">
                {projects.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between gap-3 p-3 rounded-xl bg-background border border-border hover:border-primary/40 transition-all"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-foreground truncate">{p.name}</p>
                      <p className="text-xs text-muted mt-0.5">
                        {new Date(p.updated_at).toLocaleString("ar", {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {" · "}
                        {p.word_count} كلمة
                        {p.deleted_count > 0 && ` · ${p.deleted_count} محذوفة`}
                        {p.duration > 0 && ` · ${formatTime(p.duration)}`}
                        {!p.video_exists && (
                          <span className="text-danger"> · ⚠ ملف الفيديو مفقود</span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => handleOpenProject(p.id)}
                        disabled={busy !== null}
                        className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-primary text-white text-xs font-bold hover:bg-primary-hover disabled:opacity-50 transition-colors"
                      >
                        {busy === "open-project" ? <Icon.Spinner /> : "فتح"}
                      </button>
                      <button
                        onClick={() => handleDeleteProject(p.id)}
                        className="text-danger hover:bg-danger/10 p-1.5 rounded-lg transition-colors"
                        title="حذف المشروع (لا يحذف ملف الفيديو)"
                      >
                        <Icon.Trash />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ═══ الخطوة 1: اختيار المصدر ═══ */}
          <Card step={1} title={mode === "text" ? "اختيار الملف" : "اختيار الفيديو"} active={stage === "pick"}>
            {!video ? (
              <button
                onClick={handlePick}
                disabled={busy === "pick"}
                className="w-full flex flex-col items-center justify-center gap-3 py-10 border-2 border-dashed border-border rounded-xl hover:border-primary hover:bg-primary/5 transition-all group cursor-pointer disabled:opacity-50"
              >
                <span className="text-muted group-hover:text-primary transition-colors">
                  {busy === "pick" ? <Icon.Spinner /> : <Icon.Upload />}
                </span>
                <span className="text-foreground font-medium">
                  {mode === "text" ? "اختر ملف صوت أو فيديو من جهازك" : "اختر ملف فيديو من جهازك"}
                </span>
                <span className="text-xs text-muted">
                  {mode === "text" ? "MP3, WAV, M4A · MP4, MKV, MOV…" : "MP4, AVI, MKV, MOV, WEBM"}
                </span>
              </button>
            ) : (
              <div className="flex items-center justify-between bg-background rounded-xl p-3 border border-border">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-primary/20 text-primary flex items-center justify-center shrink-0">
                    <Icon.Film />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-foreground truncate">{video.file_name}</p>
                    <p className="text-xs text-muted">{video.file_size_mb.toFixed(1)} ميجابايت</p>
                  </div>
                </div>
                <button onClick={handlePick} className="text-xs text-primary hover:text-primary-hover px-3 py-1.5 rounded-lg hover:bg-primary/10 shrink-0">
                  تغيير
                </button>
              </div>
            )}
          </Card>

          {/* ═══ الخطوة 2: استخراج الصوت (فيديو فقط — يُتخطّى للملفات الصوتية) ═══ */}
          {video && !isAudioPath(video.path) && (
            <Card step={2} title="استخراج الصوت" active={false}>
              {audioResult ? (
                <div className="flex items-start gap-3 p-3 rounded-xl bg-success/10 border border-success/30">
                  <span className="text-success shrink-0 mt-0.5"><Icon.Check /></span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-success">{audioResult.message}</p>
                    <p className="text-xs text-muted mt-1 break-all font-muto" dir="ltr">{audioResult.output_path}</p>
                  </div>
                </div>
              ) : (
                <button
                  onClick={handleExtract}
                  disabled={busy === "extract" || !ffmpegOk}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-primary text-white font-medium hover:bg-primary-hover disabled:opacity-50 transition-all"
                >
                  {busy === "extract" ? <><Icon.Spinner /> جاري الاستخراج...</> : <><Icon.Music /> استخراج الصوت (MP3)</>}
                </button>
              )}
            </Card>
          )}

          {/* ═══ الخطوة 3: كشف السكتات (مسار الفيديو فقط) ═══ */}
          {audioResult && mode === "video" && (
            <Card step={3} title="كشف السكتات والصمت" active={stage === "silence"}>
              {/* أدوات التحكم */}
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="text-xs text-muted block mb-1">حد الضوضاء (dB)</label>
                  <input
                    type="number" value={noiseDb} onChange={(e) => setNoiseDb(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-primary"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted block mb-1">الحد الأدنى للصمت (ثانية)</label>
                  <input
                    type="number" step="0.1" value={minDur} onChange={(e) => setMinDur(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-primary"
                  />
                </div>
              </div>

              <button
                onClick={handleDetectSilence}
                disabled={busy === "silence"}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-accent/20 text-accent border border-accent/40 font-medium hover:bg-accent/30 disabled:opacity-50 transition-all"
              >
                {busy === "silence" ? <><Icon.Spinner /> جاري التحليل...</> : <><Icon.VolumeOff /> كشف السكتات</>}
              </button>

              {/* عنصر صوت مخفي للمعاينة */}
              <audio
                ref={audioRef}
                src={audioUrl || undefined}
                preload="auto"
                onEnded={() => setPreviewIdx(null)}
              />

              {/* نتائج السكتات */}
              {silence && (
                <div className="mt-4 space-y-3">
                  {/* ملخص */}
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <Stat label="عدد السكتات" value={String(silence.segments.length)} />
                    <Stat label="إجمالي الصمت" value={formatTime(silence.total_silence_duration)} />
                    <Stat label="نسبة الصمت" value={`${(silence.silence_ratio * 100).toFixed(1)}%`} />
                  </div>

                  <div className="flex items-center justify-between text-xs px-1">
                    <span className={removedCount > 0 ? "text-success" : "text-muted"}>
                      {removedCount > 0
                        ? `✅ ${removedCount} من ${silence.segments.length} سكتة ستُحذف من الفيديو النهائي`
                        : "لن تُحذف أي سكتة — حدّد ما تريد حذفه"}
                    </span>
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={handleSelectAllSegments}
                        disabled={removedCount === silence.segments.length}
                        className="px-2 py-1 rounded text-danger hover:bg-danger/10 disabled:opacity-40 font-medium"
                      >
                        تحديد الكل
                      </button>
                      <button
                        onClick={handleClearAllSegments}
                        disabled={removedCount === 0}
                        className="px-2 py-1 rounded text-muted hover:bg-surface-hover disabled:opacity-40 font-medium"
                      >
                        إلغاء الكل
                      </button>
                    </div>
                  </div>

                  {/* قائمة السكتات */}
                  <div className="space-y-1.5 max-h-60 overflow-y-auto">
                    {silence.segments.map((seg, idx) => {
                      const removed = removedSegments.has(idx);
                      return (
                        <div
                          key={idx}
                          className={`flex items-center justify-between p-2.5 rounded-lg border transition-all ${
                            removed
                              ? "bg-danger/5 border-danger/30"
                              : "bg-background border-border hover:border-primary/40"
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="text-xs font-mono text-muted shrink-0">#{idx + 1}</span>
                            <div className="flex items-center gap-2 text-sm">
                              <span className="text-foreground" dir="ltr">{formatTime(seg.start)}</span>
                              <span className="text-muted">←</span>
                              <span className="text-foreground" dir="ltr">{formatTime(seg.end)}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-xs px-2 py-1 rounded bg-surface-hover text-muted" dir="ltr">
                              {seg.duration.toFixed(2)}s
                            </span>
                            <button
                              onClick={() => handlePreviewSegment(idx, seg)}
                              disabled={!audioUrl}
                              className={`p-1 rounded transition-colors disabled:opacity-40 ${
                                previewIdx === idx
                                  ? "text-primary bg-primary/10"
                                  : "text-primary hover:bg-primary/10"
                              }`}
                              title="سماع المقطع"
                            >
                              {previewIdx === idx ? <Icon.Pause /> : <Icon.Play />}
                            </button>
                            {removed ? (
                              <button
                                onClick={() => handleRestoreSegment(idx)}
                                className="text-xs text-success hover:bg-success/10 px-2 py-1 rounded"
                              >
                                تراجع
                              </button>
                            ) : (
                              <button
                                onClick={() => handleRemoveSegment(idx)}
                                className="text-danger hover:bg-danger/10 p-1 rounded"
                              >
                                <Icon.Trash />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* ═══ الخطوة 4: التفريغ الصوتي ═══ */}
          {audioResult && (
            <Card step={4} title="التفريغ الصوتي (Whisper)" active={stage === "transcribed"}>
              {/* اختيار المزود */}
              <div className="grid grid-cols-3 gap-2 mb-3">
                <button
                  onClick={() => setProvider("groq")}
                  className={`py-2 rounded-lg text-sm font-medium transition-all ${
                    provider === "groq" ? "bg-primary text-white" : "bg-surface-hover text-muted hover:text-foreground"
                  }`}
                >
                  Groq
                </button>
                <button
                  onClick={() => setProvider("openai")}
                  className={`py-2 rounded-lg text-sm font-medium transition-all ${
                    provider === "openai" ? "bg-primary text-white" : "bg-surface-hover text-muted hover:text-foreground"
                  }`}
                >
                  OpenAI
                </button>
                <button
                  onClick={() => setProvider("speechmatics")}
                  className={`py-2 rounded-lg text-sm font-medium transition-all ${
                    provider === "speechmatics" ? "bg-primary text-white" : "bg-surface-hover text-muted hover:text-foreground"
                  }`}
                >
                  Speechmatics
                </button>
              </div>

              {/* حالة المفتاح والموديل — يُدار من قسم الإعدادات */}
              <div className="mb-3 flex items-center justify-between text-xs px-3 py-2.5 rounded-lg bg-background border border-border">
                <span className={settings.keys[provider] ? "text-success" : "text-muted"}>
                  {settings.keys[provider]
                    ? `✅ مضبوط · الموديل: ${settings.transcriptionModels[provider]}`
                    : "⚠️ لا يوجد مفتاح لهذا المزوّد"}
                </span>
                <button
                  onClick={() => setShowSettings(true)}
                  className="text-primary hover:text-primary-hover font-medium shrink-0"
                >
                  فتح الإعدادات
                </button>
              </div>

              <button
                onClick={handleTranscribe}
                disabled={busy === "transcribe" || !settings.keys[provider]}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-primary text-white font-medium hover:bg-primary-hover disabled:opacity-50 transition-all"
              >
                {busy === "transcribe" ? <><Icon.Spinner /> جاري التفريغ...</> : <><Icon.Mic /> بدء التفريغ الصوتي</>}
              </button>

              {/* شريط التقدّم + الإلغاء (plan.md §0.3) */}
              {busy === "transcribe" && transcribeProgress && (
                <div className="mt-3 p-3 rounded-xl bg-background border border-border space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-foreground font-medium">{transcribeProgress.message}</span>
                    <span className="text-muted tabular-nums">{Math.round(transcribeProgress.percent)}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-surface-hover overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300"
                      style={{ width: `${Math.max(2, Math.min(100, transcribeProgress.percent))}%` }}
                    />
                  </div>
                  {transcribeProgress.chunk_total > 1 && (
                    <p className="text-[10px] text-muted">
                      القطعة {transcribeProgress.chunk_index + 1} من {transcribeProgress.chunk_total} —
                      تقسيم تلقائي لكسر سقف 25MB
                    </p>
                  )}
                  <button
                    onClick={handleCancelTranscribe}
                    className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-danger/10 text-danger text-xs font-bold hover:bg-danger/20 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                    إلغاء التفريغ
                  </button>
                </div>
              )}

              {/* نتائج التفريغ */}
              {transcription && (
                <div className="mt-4 space-y-3">
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <Stat label="عدد الكلمات" value={String(transcription.words.length)} />
                    <Stat label="المدة" value={formatTime(transcription.duration)} />
                    <Stat label="اللغة" value={transcription.language.toUpperCase()} />
                  </div>

                  {/* ═══ زر الدخول للاستوديو ═══ */}
                  <button
                    onClick={() => setStudioMode(true)}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-gradient-to-l from-primary to-primary-hover text-white font-bold hover:shadow-lg hover:shadow-primary/30 transition-all"
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M15 10l4.553-2.276A1 1 0 0 1 21 8.618v6.764a1 1 0 0 1-1.447.894L15 14M5 18h8a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2z" />
                    </svg>
                    {mode === "text" ? "دخول مسار النصّ" : "دخول استوديو تحرير الفيديو"}
                  </button>

                  {/* النص الكامل */}
                  <div className="p-3 rounded-xl bg-background border border-border">
                    <p className="text-xs text-muted mb-2 flex items-center gap-1"><Icon.Doc /> النص المُفرّغ</p>
                    <p className="text-sm text-foreground leading-relaxed">{transcription.full_text}</p>
                  </div>

                  {/* الكلمات مع الطوابع الزمنية */}
                  <div className="p-3 rounded-xl bg-background border border-border">
                    <p className="text-xs text-muted mb-2">الكلمات (Word-level timestamps)</p>
                    <div className="flex flex-wrap gap-1 max-h-48 overflow-y-auto">
                      {transcription.words.map((w: WordTimestamp, i: number) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-surface-hover text-xs text-foreground hover:bg-primary/20 hover:text-primary transition-colors cursor-default"
                          title={`${formatTime(w.start)} → ${formatTime(w.end)}`}
                        >
                          <span>{w.word}</span>
                          <span className="text-muted/60" dir="ltr">{w.start.toFixed(1)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* خطأ عام */}
          {error && (
            <div className="flex items-start gap-3 p-4 rounded-xl bg-danger/10 border border-danger/30">
              <span className="text-danger shrink-0 mt-0.5"><Icon.Alert /></span>
              <div className="flex-1">
                <p className="text-sm font-medium text-danger">حدث خطأ</p>
                <pre className="text-xs text-muted mt-1 whitespace-pre-wrap break-words">{error}</pre>
              </div>
            </div>
          )}

          {/* تذييل */}
          <div className="text-center text-xs text-muted/50 py-4">
            محرر الفيديو العربي — المرحلة 2 — مفتوح المصدر
          </div>
        </div>
      </main>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  مكوّنات مساعدة
// ═══════════════════════════════════════════════════════════════

function ModeCard({
  active,
  onClick,
  title,
  desc,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-right p-4 rounded-2xl border transition-all ${
        active
          ? "border-primary bg-primary/10 shadow-lg shadow-primary/10"
          : "border-border bg-surface hover:border-primary/40"
      }`}
    >
      <div
        className={`w-9 h-9 rounded-xl flex items-center justify-center mb-2 ${
          active ? "bg-primary/20 text-primary" : "bg-surface-hover text-muted"
        }`}
      >
        {icon}
      </div>
      <p className={`text-sm font-bold ${active ? "text-primary" : "text-foreground"}`}>
        {title}
      </p>
      <p className="text-[11px] text-muted mt-0.5 leading-snug">{desc}</p>
    </button>
  );
}

function Card({ step, title, children, active }: { step: number; title: string; children: React.ReactNode; active: boolean }) {
  return (
    <div className={`bg-surface rounded-2xl border p-5 space-y-3 transition-all ${
      active ? "border-primary/50 shadow-lg shadow-primary/5" : "border-border"
    }`}>
      <h2 className="text-sm font-semibold text-muted uppercase tracking-wider flex items-center gap-2">
        <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
          active ? "bg-primary text-white" : "bg-surface-hover text-muted"
        }`}>
          {step}
        </span>
        {title}
      </h2>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-2 rounded-lg bg-background border border-border">
      <p className="text-xs text-muted">{label}</p>
      <p className="text-sm font-bold text-foreground mt-0.5">{value}</p>
    </div>
  );
}
