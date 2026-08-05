/**
 * ═══════════════════════════════════════════════════════════════
 *  core/document/migrate.ts
 *  تحويلات وترحيل نموذج المستند الموحّد
 *
 *  - بناء المستند من نتيجة التفريغ الآلي (ASR).
 *  - جسر النواة الجديدة مع واجهة المحرّر الحالية (WordState).
 *  - ترحيل مشاريع v1 (Word[]) إلى v2 (تدفّق توكِنات).
 *
 *  راجع plan.md §2.4 (خطة الترحيل).
 * ═══════════════════════════════════════════════════════════════
 */

import type { TranscriptionResult, WordTimestamp } from "@/lib/tauri-api";
import type { WordState } from "@/lib/editor-utils";
import type { Token, TranscriptDocument } from "./types";
import type { ProjectDataV1, ProjectDataV2 } from "@/lib/project";
import { splitParagraphs } from "./paragraphs";

// ───────────────────────────────────────────────────────────────
//  التقاط الترقيم المجاني (plan.md §4 / §2.2)
//  Whisper: الحقل `text` مرقّم بينما `words[]` خام — محاذاة بسيطة تُلصق
//  الترقيم بنصّ الكلمة (مثل «قال:») فيصير قابلًا لكشف نهايات الجمل.
// ───────────────────────────────────────────────────────────────

/** يحذف كل ما ليس حرفًا/رقمًا (لمقارنة الكلمات تجاهلًا للترقيم) */
function normalizeWord(s: string): string {
  return s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

/**
 * محاذاة الكلمات الخام مع النص المرقّم الكامل لإلصاق الترقيم بنصوصها.
 * - الحالة الشائعة (Whisper): عدد التوكنات النصّية = عدد الكلمات → محاذاة 1:1.
 * - خلاف ذلك: محاذاة جشعة بالتطابق المعياري مع حدّ بحث صغير.
 * إن تعذّرت المحاذاة تُعاد الكلمات كما هي (يتعامل معها محرّك الفقرات بالفجوات).
 */
export function alignWordsToText(
  words: WordTimestamp[],
  fullText: string
): WordTimestamp[] {
  const textTokens = fullText.split(/\s+/).filter(Boolean);
  if (textTokens.length === 0) return words;

  // 1:1 — الحالة الشائعة
  if (textTokens.length === words.length) {
    return words.map((w, i) => ({ ...w, word: textTokens[i] }));
  }

  // محاذاة جشعة بالتطابق المعياري
  const out = words.map((w) => ({ ...w }));
  let ti = 0;
  const WINDOW = 3; // سمح بتجاوز عدد قليل من توكنات الترقيم/الضمائم
  for (let wi = 0; wi < out.length && ti < textTokens.length; wi++) {
    const wn = normalizeWord(out[wi].word);
    let found = -1;
    for (let k = 0; k <= WINDOW && ti + k < textTokens.length; k++) {
      if (normalizeWord(textTokens[ti + k]) === wn) {
        found = ti + k;
        break;
      }
    }
    if (found >= 0) {
      out[wi].word = textTokens[found];
      ti = found + 1;
    } else if (wi < out.length - 1) {
      // لم نطابق هذه الكلمة — نتركها خام ونتقدّم في النص حذوًا تقريبيًا
      ti += 1;
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────
//  البناء من التفريغ الآلي
// ───────────────────────────────────────────────────────────────

/**
 * ابنِ مستنداً جديداً من نتيجة تفريغ ASR خام.
 * كل كلمة ← توكِن نشط من نوع word بمصدر asr.
 */
export function transcriptionToDocument(
  result: TranscriptionResult,
  sourceKind: "audio" | "video",
  provider: string,
): TranscriptDocument {
  const tokens: Token[] = result.words.map((w, i) => ({
    id: `w_${i}`,
    kind: "word",
    text: w.word,
    start: w.start,
    end: w.end,
    confidence: w.confidence,
    status: "active",
    origin: "asr",
  }));

  return {
    tokens,
    paragraphs: [],
    meta: {
      sourceKind,
      duration: result.duration,
      provider,
      language: result.language,
    },
  };
}

// ───────────────────────────────────────────────────────────────
//  الجسر مع واجهة المحرّر الحالية (WordState)
//  الواجهة الحالية لا تزال تعمل بمصفوفة WordState — هذا الجسر
//  يحوّل بينها وبين تدفّق التوكنات عند حدود الحفظ/الفتح فقط.
// ───────────────────────────────────────────────────────────────

/**
 * حوّل حالة المحرّر (WordState) إلى توكِنات، مع الحفاظ على:
 *  - معرّفات التوكنات الموجودة (الاستقرار عبر الجلسات).
 *  - النصّ الأصلي (originalText) المسجّل سابقاً، أو اشتقاقه من التفريغ الأصلي.
 *
 * @param words حالة المحرّر الحالية (محاذية بالفهرس مع originalWords)
 * @param originalWords التفريغ الأصلي (محاذٍ بالفهرس) — لاشتقاق originalText
 * @param existing توكِنات موجودة مسبقاً (للحفاظ على المعرّفات والنصّ الأصلي)
 */
export function wordStateToTokens(
  words: WordState[],
  originalWords: WordTimestamp[],
  existing?: Token[],
): Token[] {
  // التوكنات الكلامية الموجودة فقط (محاذية بالفهرس مع words)
  const existingWords = existing?.filter((t) => t.kind === "word") ?? [];

  return words.map((w, i) => {
    const edited = w.edited === true;
    const prev = existingWords[i];
    const orig = originalWords[i];

    let originalText: string | undefined;
    if (edited) {
      if (prev?.originalText !== undefined) {
        // النصّ الأصلي مسجّل سابقاً → نحافظ عليه
        originalText = prev.originalText;
      } else if (orig && orig.word !== w.word) {
        // أول تعديل → نشتقّ الأصل من التفريغ
        originalText = orig.word;
      }
    }

    return {
      id: prev?.id ?? `w_${i}`,
      kind: "word" as const,
      text: w.word,
      start: w.start,
      end: w.end,
      confidence: w.confidence,
      status: w.deleted ? ("removed" as const) : ("active" as const),
      origin: edited ? ("user" as const) : ("asr" as const),
      originalText,
    };
  });
}

/**
 * مزامنة مستند كامل من حالة المحرّر
 * (يحافظ على paragraphs/meta/speakers دون تغيير).
 */
export function syncDocumentFromWordState(
  doc: TranscriptDocument,
  words: WordState[],
  originalWords: WordTimestamp[],
): TranscriptDocument {
  return {
    ...doc,
    tokens: wordStateToTokens(words, originalWords, doc.tokens),
  };
}

/**
 * حوّل توكِنات المستند إلى حالة المحرّر (WordState) — جسر الواجهة الحالية.
 * توكِنات الترقيم/الفواصل تُستثنى (لا تمثّل كلمات قابلة للتحرير).
 */
export function tokensToWordState(tokens: Token[]): WordState[] {
  let id = 0;
  const out: WordState[] = [];
  for (const t of tokens) {
    if (t.kind !== "word") continue;
    out.push({
      id: id++,
      word: t.text,
      start: t.start ?? 0,
      end: t.end ?? 0,
      deleted: t.status === "removed",
      edited: t.origin !== "asr",
      confidence: t.confidence,
    });
  }
  return out;
}

/**
 * أعد بناء TranscriptionResult من المستند — للواجهة الحالية عند فتح مشروع.
 * يتضمّن كل التوكنات الكلامية (نشطة ومستبعدة) للحفاظ على محاذاة الفهارس
 * مع studioWords.
 */
export function documentToTranscription(
  doc: TranscriptDocument,
  fullText: string,
): TranscriptionResult {
  const words: WordTimestamp[] = [];
  for (const t of doc.tokens) {
    if (t.kind !== "word") continue;
    words.push({
      word: t.text,
      start: t.start ?? 0,
      end: t.end ?? 0,
      confidence: t.confidence,
    });
  }
  return {
    words,
    full_text: fullText,
    language: doc.meta.language ?? "ar",
    duration: doc.meta.duration,
  };
}

// ───────────────────────────────────────────────────────────────
//  ترحيل v1 → v2
// ───────────────────────────────────────────────────────────────

/**
 * ترحيل حمولة مشروع v1 (Word[]) إلى v2 (تدفّق توكِنات).
 *
 * - التفريغ الأصلي يُبنى منه المستند الأساسي.
 * - كلمات المحرّر المحفوظة (إن وُجدت) تُطبَّق فوقه: الحذف، التعديل، الثقة.
 * - غير مدمّر: لا تفقد أيّ معلومة من v1.
 */
export function migrateProjectV1ToV2(data: ProjectDataV1): ProjectDataV2 {
  const transcription = data.transcription;

  if (!transcription || transcription.words.length === 0) {
    return {
      version: 2,
      mode: "video",
      video: data.video,
      audioPath: data.audioPath,
      noiseDb: data.noiseDb,
      minDur: data.minDur,
      silence: data.silence,
      removedSegments: data.removedSegments,
      document: {
        tokens: [],
        paragraphs: [],
        meta: { sourceKind: "video", duration: 0, provider: "" },
      },
      fullText: "",
      duration: 0,
    };
  }

  let document = transcriptionToDocument(transcription, "video", "");
  // التقاط الترقيم من النص الكامل إن كانت الكلمات خام (Whisper)
  if (transcription.full_text) {
    const aligned = alignWordsToText(
      transcription.words,
      transcription.full_text
    );
    document = transcriptionToDocument(
      { ...transcription, words: aligned },
      "video",
      ""
    );
  }
  const fullText = transcription.full_text;
  const duration = transcription.duration;

  // تطبيق حالة المحرّر المحفوظة (حذف/تعديل) فوق المستند الأساسي
  if (data.words && data.words.length > 0) {
    document = syncDocumentFromWordState(document, data.words, transcription.words);
  }

  // تقسيم الفقرات (plan.md §5)
  document.paragraphs = splitParagraphs(document.tokens);

  return {
    version: 2,
    mode: "video",
    video: data.video,
    audioPath: data.audioPath,
    noiseDb: data.noiseDb,
    minDur: data.minDur,
    silence: data.silence,
    removedSegments: data.removedSegments,
    document,
    fullText,
    duration,
  };
}
