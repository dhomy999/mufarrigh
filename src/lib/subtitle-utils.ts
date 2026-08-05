/**
 * ═══════════════════════════════════════════════════════════════
 *  subtitle-utils.ts
 *  توليد ملفات الترجمة (SRT / WebVTT) من كلمات المحرر
 * ═══════════════════════════════════════════════════════════════
 */

import type { WordState, ExcludedRange } from "./editor-utils";
import { mergeRanges } from "./editor-utils";

/** سطر ترجمة واحد */
export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

// ─── حدود تجميع الكلمات في سطر واحد ────────────────────────────
const MAX_CUE_DURATION = 5.0; // أقصى مدة للسطر بالثواني
const MAX_CUE_CHARS = 42; // أقصى عدد أحرف للسطر
const GAP_SPLIT = 0.7; // فجوة صمت (ثانية) تفصل بين سطرين

/**
 * تحويل توقيت من الفيديو الأصلي إلى توقيت الفيديو بعد حذف الفترات
 * (بطرح مدد الفترات المحذوفة الواقعة قبل التوقيت)
 *
 * @param mergedRanges فترات محذوفة مدمجة ومرتبة (ناتج mergeRanges)
 */
export function remapTime(t: number, mergedRanges: ExcludedRange[]): number {
  let removed = 0;
  for (const r of mergedRanges) {
    if (r.start >= t) break;
    removed += Math.min(r.end, t) - r.start;
  }
  return Math.max(0, t - removed);
}

/**
 * تجميع الكلمات غير المحذوفة في أسطر ترجمة
 *
 * يبدأ سطر جديد عند: فجوة صمت طويلة، أو تجاوز أقصى مدة، أو أقصى طول نص.
 *
 * @param remapToFinal إذا true تُزاح التوقيتات لتطابق الفيديو المُصدَّر بعد الحذف
 */
export function buildSubtitleCues(
  words: WordState[],
  excludedRanges: ExcludedRange[],
  remapToFinal: boolean
): SubtitleCue[] {
  const ranges = remapToFinal ? mergeRanges(excludedRanges) : [];
  const kept = words.filter((w) => !w.deleted && w.word.trim() !== "");

  const cues: SubtitleCue[] = [];
  let start = 0;
  let end = 0;
  let parts: string[] = [];

  const flush = () => {
    if (parts.length === 0) return;
    let s = start;
    let e = end;
    if (remapToFinal) {
      s = remapTime(s, ranges);
      e = remapTime(e, ranges);
    }
    // سطر انهارت مدته بعد الإزاحة = كلماته داخل فترة محذوفة → يُهمل
    if (e - s >= 0.05) {
      cues.push({ start: s, end: e, text: parts.join(" ") });
    }
    parts = [];
  };

  for (const w of kept) {
    const text = w.word.trim();
    if (parts.length === 0) {
      start = w.start;
      end = w.end;
      parts.push(text);
      continue;
    }
    const lineChars = parts.join(" ").length + 1 + text.length;
    if (
      w.start - end > GAP_SPLIT ||
      w.end - start > MAX_CUE_DURATION ||
      lineChars > MAX_CUE_CHARS
    ) {
      flush();
      start = w.start;
      end = w.end;
      parts.push(text);
    } else {
      end = w.end;
      parts.push(text);
    }
  }
  flush();

  return cues;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** تنسيق التوقيت — SRT يفصل الأجزاء بفاصلة، وVTT بنقطة */
function formatTimestamp(t: number, msSeparator: "," | "."): string {
  const totalMs = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSeparator}${String(ms).padStart(3, "0")}`;
}

/** تسلسل الأسطر بصيغة SRT */
export function toSRT(cues: SubtitleCue[]): string {
  return cues
    .map(
      (c, i) =>
        `${i + 1}\n${formatTimestamp(c.start, ",")} --> ${formatTimestamp(c.end, ",")}\n${c.text}\n`
    )
    .join("\n");
}

/** تسلسل الأسطر بصيغة WebVTT */
export function toVTT(cues: SubtitleCue[]): string {
  const body = cues
    .map(
      (c) =>
        `${formatTimestamp(c.start, ".")} --> ${formatTimestamp(c.end, ".")}\n${c.text}\n`
    )
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

/**
 * قصّ أسطر الترجمة إلى نطاق [start, end] مع إعادة التوقيت إلى صفر
 * (plan.md §4.1) — يُستخدم لتوليد ملف SRT مصاحب لكل Short.
 */
export function clipCuesToRange(
  cues: SubtitleCue[],
  start: number,
  end: number
): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (const c of cues) {
    if (c.end <= start || c.start >= end) continue;
    const cs = Math.max(c.start, start) - start;
    const ce = Math.min(c.end, end) - start;
    if (ce - cs >= 0.05) {
      out.push({ start: cs, end: ce, text: c.text });
    }
  }
  return out;
}
