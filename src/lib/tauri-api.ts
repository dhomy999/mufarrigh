/**
 * ═══════════════════════════════════════════════════════════════
 *  واجهة برمجة التطبيقات (API Bridge)
 *  الجسر بين الواجهة الأمامية وأوامر Tauri الخلفية (Rust)
 *  المرحلة 1 + 2
 * ═══════════════════════════════════════════════════════════════
 */

const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ───────────────────────────────────────────────────────────────
//  الأنواع (Types) — مطابقة لـ Rust structs
// ───────────────────────────────────────────────────────────────

/** معلومات ملف الفيديو */
export interface VideoInfo {
  path: string;
  file_name: string;
  file_size_mb: number;
}

/** نتيجة استخراج الصوت */
export interface AudioExtractionResult {
  success: boolean;
  output_path: string;
  message: string;
  output_size_mb: number;
}

/** خطأ موحد من الخلفية */
export interface AppError {
  error_type: string;
  message: string;
  details: string | null;
}

// ─── المرحلة 2 ─────────────────────────────────────────────────

/** فترة سكتة (صمت) مكتشفة */
export interface SilenceSegment {
  /** بداية السكتة بالثواني */
  start: number;
  /** نهاية السكتة بالثواني */
  end: number;
  /** مدة السكتة بالثواني */
  duration: number;
}

/** نتيجة كشف السكتات */
export interface SilenceDetectionResult {
  segments: SilenceSegment[];
  total_silence_duration: number;
  total_audio_duration: number;
  silence_count: number;
  /** نسبة الصمت من إجمالي الملف (0.0 - 1.0) */
  silence_ratio: number;
}

/** كلمة واحدة مع طابع زمني */
export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
  /**
   * درجة ثقة النموذج بالكلمة (0.0 - 1.0).
   * Speechmatics تُرجعها في json-v2، أما Whisper (groq/openai) فلا ⇒ undefined
   */
  confidence?: number;
}

/** نتيجة التفريغ الصوتي */
export interface TranscriptionResult {
  words: WordTimestamp[];
  full_text: string;
  language: string;
  duration: number;
}

/** مزود التفريغ الصوتي */
export type TranscriptionProvider = "groq" | "openai" | "speechmatics";
/** مزوّد النماذج النصّية (OpenAI / Anthropic / Gemini) */
export type TextProvider = "openai" | "anthropic" | "gemini";

/** حمولة حدث تقدّم التفريغ القادم من الخلفية (transcribe-progress) */
export interface TranscribeProgress {
  /** المرحلة: preparing | transcribing | merging | done */
  stage: string;
  /** رقم القطعة الحالية (0-based) */
  chunk_index: number;
  /** إجمالي القطع */
  chunk_total: number;
  /** النسبة المئوية 0..100 */
  percent: number;
  /** رسالة بالعربية للعرض */
  message: string;
}

// ─── المرحلة 4 ─────────────────────────────────────────────────

/** فترة زمنية مستبعدة (محذوفة) من الفيديو */
export interface TimeRange {
  start: number;
  end: number;
}

/** نتيجة التصدير النهائي */
export interface ExportResult {
  success: boolean;
  output_path: string;
  output_size_mb: number;
  original_duration: number;
  final_duration: number;
  message: string;
}

/** اقتراح مقطع قصير (Short) من الـ LLM */
export interface ShortSuggestion {
  title: string;
  start: number;
  end: number;
  reason: string;
}

/** نتيجة استخراج Short */
export interface ShortExtractResult {
  success: boolean;
  output_path: string;
  title: string;
  duration: number;
  message: string;
  /** مسار ملف SRT المقصوص (إن وُجد — plan.md §4.1) */
  srt_path?: string | null;
}

/** مزود LLM لتوليد Shorts */
export type LLMProvider = "openai" | "anthropic" | "gemini";

/** موضع مشبوه في التفريغ (خطأ محتمل / كلام غير منطقي) */
export interface TranscriptIssue {
  /** النص المشبوه كما ورد في التفريغ */
  text: string;
  /** بداية الموضع بالثواني */
  start: number;
  /** نهاية الموضع بالثواني */
  end: number;
  /** سبب اعتباره خطأً محتملاً */
  reason: string;
  /** تصحيح مقترح (قد يكون فارغاً) */
  suggestion: string;
  /** درجة الخطورة: "high" | "medium" | "low" */
  severity: string;
}

// ───────────────────────────────────────────────────────────────
//  أوامر المرحلة 1
// ───────────────────────────────────────────────────────────────

/** 📂 فتح نافذة اختيار ملف فيديو */
export async function pickVideoFile(): Promise<VideoInfo | null> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<VideoInfo | null>("pick_video_file");
  } catch (error) {
    throw normalizeError(error);
  }
}

/** 📂 فتح نافذة اختيار ملف صوت أو فيديو (مسار النصّ — plan.md §3.1) */
export async function pickMediaFile(): Promise<VideoInfo | null> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<VideoInfo | null>("pick_media_file");
  } catch (error) {
    throw normalizeError(error);
  }
}

/** 🎵 استخراج الصوت من الفيديو */
export async function extractAudio(
  videoPath: string
): Promise<AudioExtractionResult> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<AudioExtractionResult>("extract_audio", {
      videoPath,
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

/** ℹ️ فحص توفّر FFmpeg */
export async function checkFFmpegAvailable(): Promise<boolean> {
  if (!isTauri()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<boolean>("ffmpeg_status");
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────────────────────
//  أوامر المرحلة 2
// ───────────────────────────────────────────────────────────────

/** 🔇 كشف السكتات والصمت في ملف صوتي
 *
 * @param audioPath مسار ملف الصوت أو الفيديو
 * @param noiseThreshold حد الضوضاء بالديسيبل (افتراضي: -30)
 * @param minDuration الحد الأدنى لمدة الصمت بالثواني (افتراضي: 0.5)
 */
export async function detectSilence(
  audioPath: string,
  noiseThreshold?: number,
  minDuration?: number
): Promise<SilenceDetectionResult> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const result = await invoke<SilenceDetectionResult>("detect_silence", {
      audioPath,
      noiseThreshold: noiseThreshold ?? null,
      minDuration: minDuration ?? null,
    });
    return {
      ...result,
      silence_count: result.segments.length,
    };
  } catch (error) {
    throw normalizeError(error);
  }
}

/** 🎙️ تفريغ صوتي عبر Groq / OpenAI Whisper أو Speechmatics
 *
 * @param audioPath مسار ملف الصوت
 * @param apiKey مفتاح الـ API
 * @param provider المزود: "groq" أو "openai" أو "speechmatics" (افتراضي: groq)
 * @param model اسم الموديل (يُتجاهل مع Speechmatics)
 * @param language كود اللغة (افتراضي: "ar" للعربية)
 *
 * ملاحظة: Speechmatics واجهة غير متزامنة (job-based) وقد تستغرق عدة دقائق.
 */
export async function transcribeAudio(
  audioPath: string,
  apiKey: string,
  provider?: TranscriptionProvider,
  model?: string,
  language?: string,
  additionalVocab?: string[]
): Promise<TranscriptionResult> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<TranscriptionResult>("transcribe_audio", {
      audioPath,
      apiKey,
      provider: provider ?? null,
      model: model ?? null,
      language: language ?? null,
      additionalVocab: additionalVocab ?? null,
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

/**
 * 🪧 اقتراح عناوين الفقرات عبر نموذج لغوي (plan.md §3.3 / §5.2).
 * اقتراحات فقط — التطبيق يتم بمراجعة صريحة.
 */
export interface ParagraphInput {
  startTokenId: string;
  endTokenId: string;
  text: string;
}
export interface HeadingSuggestion {
  beforeTokenId: string;
  heading: string;
}
export async function generateParagraphHeadings(
  paragraphs: ParagraphInput[],
  apiKey: string,
  provider?: TextProvider,
  model?: string,
  language?: string
): Promise<HeadingSuggestion[]> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<HeadingSuggestion[]>("generate_paragraph_headings", {
      paragraphs,
      apiKey,
      provider: provider ?? null,
      model: model ?? null,
      language: language ?? null,
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

/** ✋ إلغاء التفريغ الجاري (يضبط العلم المشترك في الخلفية) */
export async function cancelTranscription(): Promise<void> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("cancel_transcription");
  } catch (error) {
    throw normalizeError(error);
  }
}

// ───────────────────────────────────────────────────────────────
//  أوامر المرحلة 4 — التصدير + Shorts
// ───────────────────────────────────────────────────────────────

/** 🎬 تصدير الفيديو النهائي بعد إزالة الأجزاء المحذوفة */
export async function exportVideo(
  videoPath: string,
  excludedRanges: TimeRange[],
  outputDir?: string
): Promise<ExportResult> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<ExportResult>("export_video", {
      videoPath,
      excludedRanges,
      outputDir: outputDir ?? null,
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

/** 🤖 توليد اقتراحات مقاطع قصيرة (Shorts) عبر LLM
 *
 * @param systemPrompt برومت مخصّص (اختياري) — إن غاب يُستخدم الافتراضي في الخلفية
 */
export async function generateShorts(
  transcriptJson: string,
  apiKey: string,
  provider?: LLMProvider,
  model?: string,
  systemPrompt?: string
): Promise<ShortSuggestion[]> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<ShortSuggestion[]>("generate_shorts", {
      transcriptJson,
      apiKey,
      provider: provider ?? null,
      model: model ?? null,
      systemPrompt: systemPrompt ?? null,
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

/** 🔍 كشف المواضع غير المنطقية في التفريغ (أخطاء تفريغ محتملة) عبر LLM
 *
 * @param transcriptJson JSON يحتوي على { words: [{word, start, end}, ...] }
 * @param apiKey مفتاح الـ API
 * @param provider المزوّد: "openai" | "anthropic" | "gemini" (افتراضي: gemini)
 * @param model اسم الموديل
 * @param language كود اللغة (للسياق فقط، افتراضي: "ar")
 * @param systemPrompt برومت مخصّص (اختياري) — إن غاب يُستخدم الافتراضي في الخلفية
 */
export async function detectTranscriptIssues(
  transcriptJson: string,
  apiKey: string,
  provider?: LLMProvider,
  model?: string,
  language?: string,
  systemPrompt?: string
): Promise<TranscriptIssue[]> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<TranscriptIssue[]>("detect_transcript_issues", {
      transcriptJson,
      apiKey,
      provider: provider ?? null,
      model: model ?? null,
      language: language ?? null,
      systemPrompt: systemPrompt ?? null,
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

/** ✂️ استخراج مقطع قصير كملف منفصل (plan.md §4: قوالب + ترجمة محروقة + SRT) */
export async function extractShort(
  videoPath: string,
  start: number,
  end: number,
  title: string,
  outputDir?: string,
  options?: {
    /** "original" | "blur-9x16" | "crop-9x16" */
    template?: string;
    /** ترجمة محروقة داخل الفيديو (libass) */
    burnSubtitles?: boolean;
    /** نص SRT مقصوص مسبقًا ومُعاد توقيته للصفر */
    srtContent?: string;
  }
): Promise<ShortExtractResult> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<ShortExtractResult>("extract_short", {
      videoPath,
      start,
      end,
      title,
      outputDir: outputDir ?? null,
      template: options?.template ?? null,
      burnSubtitles: options?.burnSubtitles ?? null,
      srtContent: options?.srtContent ?? null,
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

/** 📂 فتح مجلد المخرجات في مستكشف الملفات مع تحديد الملف */
export async function revealInFolder(path: string): Promise<void> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("reveal_in_folder", { path });
  } catch (error) {
    throw normalizeError(error);
  }
}

/** 📁 فتح حوار اختيار مجلد المخرجات (null = ألغى المستخدم) */
export async function pickOutputFolder(): Promise<string | null> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<string | null>("pick_output_folder");
  } catch (error) {
    throw normalizeError(error);
  }
}

/**
 * 📦 تصدير مشروع إلى ملف JSON عبر حوار حفظ (plan.md §5.4).
 * @returns مسار الحفظ أو null عند الإلغاء
 */
export async function exportProjectFile(
  json: string,
  defaultName: string
): Promise<string | null> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<string | null>("export_project_file", {
      json,
      defaultName,
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

/**
 * 📂 استيراد مشروع من ملف JSON عبر حوار فتح (plan.md §5.4).
 * @returns محتوى JSON أو null عند الإلغاء
 */
export async function importProjectFile(): Promise<string | null> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<string | null>("import_project_file");
  } catch (error) {
    throw normalizeError(error);
  }
}
export async function exportDocx(
  bytes: Uint8Array,
  defaultName: string
): Promise<string | null> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<string | null>("export_docx", {
      bytes: Array.from(bytes),
      defaultName,
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

// ───────────────────────────────────────────────────────────────
//  دوال تنسيق مساعدة
// ───────────────────────────────────────────────────────────────

/** تنسيق الوقت بالثواني إلى MM:SS أو HH:MM:SS */
export function formatTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  if (hrs > 0) {
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}.${String(ms).padStart(3, "0")}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// ───────────────────────────────────────────────────────────────
//  معالجة الأخطاء
// ───────────────────────────────────────────────────────────────

export function normalizeError(error: unknown): AppError {
  if (typeof error === "object" && error !== null && "error_type" in error) {
    return error as AppError;
  }

  if (typeof error === "string") {
    try {
      return JSON.parse(error) as AppError;
    } catch {
      return { error_type: "Unknown", message: error, details: null };
    }
  }

  return {
    error_type: "Unknown",
    message: "حدث خطأ غير متوقع",
    details: String(error),
  };
}
