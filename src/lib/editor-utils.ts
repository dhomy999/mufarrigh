/**
 * ═══════════════════════════════════════════════════════════════
 *  editor-utils.ts
 *  أنواع ودوال مساعدة لاستوديو التحرير النصي
 * ═══════════════════════════════════════════════════════════════
 */

/** فترة زمنية مستبعدة (محذوفة) */
export interface ExcludedRange {
  start: number;
  end: number;
}

/** حالة كلمة في المحرر */
export interface WordState {
  id: number;
  word: string;
  start: number;
  end: number;
  deleted: boolean;
  /** عُدّل نصّها يدوياً (تحتفظ بنفس التوقيت الزمني) */
  edited?: boolean;
  /**
   * درجة ثقة النموذج بالكلمة (0.0 - 1.0) — من Speechmatics فقط.
   * تُصبح undefined بعد التعديل اليدوي (النص لم يعد من النموذج).
   */
  confidence?: number;
}

// ───────────────────────────────────────────────────────────────
//  درجات الثقة (Confidence)
// ───────────────────────────────────────────────────────────────

/** أقل من هذا الحد = ثقة منخفضة جداً (الأرجح أنها خطأ) */
export const CONFIDENCE_LOW = 0.5;
/** أقل من هذا الحد = ثقة متوسطة (تستحق مراجعة سريعة) */
export const CONFIDENCE_MEDIUM = 0.8;

/** تصنيف درجة الثقة: منخفضة / متوسطة / سليمة أو غير متوفّرة (null) */
export type ConfidenceLevel = "low" | "medium" | null;

/**
 * تصنيف كلمة حسب درجة ثقتها.
 * الكلمات بلا درجة (Whisper) أو المُعدّلة يدوياً تُعاد كـ null فلا تُلوَّن.
 */
export function confidenceLevel(word: WordState): ConfidenceLevel {
  const c = word.confidence;
  if (c === undefined || c === null || word.edited) return null;
  if (c < CONFIDENCE_LOW) return "low";
  if (c < CONFIDENCE_MEDIUM) return "medium";
  return null;
}

/** هل يحمل التفريغ درجات ثقة أصلاً؟ (يحدّد إظهار أدوات الثقة) */
export function hasConfidenceData(words: WordState[]): boolean {
  return words.some((w) => typeof w.confidence === "number");
}

/** عدّ الكلمات منخفضة/متوسطة الثقة (تتجاهل المحذوفة) */
export function countLowConfidence(words: WordState[]): {
  low: number;
  medium: number;
} {
  let low = 0;
  let medium = 0;
  for (const w of words) {
    if (w.deleted) continue;
    const level = confidenceLevel(w);
    if (level === "low") low++;
    else if (level === "medium") medium++;
  }
  return { low, medium };
}

/** تنسيق الثقة كنسبة مئوية: 0.427 → "43%" */
export function formatConfidence(c: number): string {
  return `${Math.round(c * 100)}%`;
}

/**
 * دمج الفترات الزمنية المتداخلة أو المتجاورة
 * مثال: [{0,1},{1,2},{5,6}] → [{0,2},{5,6}]
 */
export function mergeRanges(ranges: ExcludedRange[]): ExcludedRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: ExcludedRange[] = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end + 0.001) {
      // متداخلة أو متجاورة → ادمج
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

/**
 * البحث عن فترة مستبعدة تحتوي وقتاً معيناً
 * @returns الفترة إذا وُجدت، أو null
 */
export function findExcludedRange(
  time: number,
  ranges: ExcludedRange[]
): ExcludedRange | null {
  // البحث الثنائي لتحسين الأداء (ranges مرتبة بعد الدمج)
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (time >= r.start && time < r.end) {
      return r;
    }
    if (time < r.start) {
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return null;
}

/**
 * حساب إجمالي المدة المحذوفة
 */
export function totalExcludedDuration(ranges: ExcludedRange[]): number {
  return mergeRanges(ranges).reduce((sum, r) => sum + (r.end - r.start), 0);
}

/**
 * تحويل مؤشرات الكلمات المحذوفة إلى فترات زمنية مدمجة
 */
export function deletedWordsToRanges(words: WordState[]): ExcludedRange[] {
  const deleted = words.filter((w) => w.deleted).map((w) => ({
    start: w.start,
    end: w.end,
  }));
  return mergeRanges(deleted);
}

/**
 * تنسيق الوقت: 75.3 → "01:15.300"
 */
export function formatTimecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/**
 * تنسيق مختصر: 75.3 → "1:15"
 */
export function formatTimeShort(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
