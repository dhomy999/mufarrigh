/**
 * ═══════════════════════════════════════════════════════════════
 *  core/document/paragraphs.ts
 *  محرّك تقسيم الفقرات — المشكلة التقنية الأولى (plan.md §5)
 *
 *  مع متحدّث واحد لساعتين لا توجد إشارة «تغيّر المتكلّم»، فينتج
 *  جدار نصّ من آلاف الكلمات. هذا المحرّك يقسّمه إلى فقرات معنوية.
 *
 *  الخوارزمية (§5.1):
 *    1. اجمع الفجوات الزمنية بعد نهايات الجمل (كلمات تنتهي بـ . ؟ !).
 *    2. threshold = المئين 75 لهذا التوزيع (تكيّفي: المتحدث يُقارَن بنفسه).
 *    3. لكل نهاية جملة: إذا كانت الفجوة ≥ threshold → فاصل فقرة.
 *    4. سقف 120 كلمة: أجبر فاصلاً عند أقرب نهاية جملة (أو قطع صلب).
 *    5. أرضية 25 كلمة: ادمج الفقرة القصيرة مع التالية.
 *
 *  تراجع آمن: إن لم تُكتشف نهايات جمل (تفريغ بلا ترقيم) نعتمد الفجوات
 *  كلها + السقف الصلب كي لا نخرج بفقرة واحدة عملاقة.
 * ═══════════════════════════════════════════════════════════════
 */

import type { Token, Paragraph } from "./types";

/** علامات نهاية الجملة العربية/اللاتينية */
const TERMINAL_PUNCT = /[.؟!\u061F\u06D4]\s*$/;

const MAX_PARA_WORDS = 120; // سقف: أجبر فاصلاً بعد هذا العدد
const HARD_CEILING = 140; // قطع صلب إن لم تُوجد نهاية جملة
const MIN_PARA_WORDS = 25; // أرضية: ادمج ما دونها مع التالية
const PERCENTILE = 0.75;

/** هل ينتهي نصّ التوكن بعلامة ترقيم ختامية؟ */
function isSentenceEnd(t: Token): boolean {
  if (t.kind !== "word") return false;
  return TERMINAL_PUNCT.test(t.text.trim());
}

/** المئين (p) لمصفوفة قيم — يُفترض مرتّبة تصاعدياً */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.POSITIVE_INFINITY;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * يقسّم التوكنات إلى فقرات وفق §5.1.
 *
 * @param tokens تدفّق التوكنات (يُعالج منها الكلمات فقط)
 * @returns فقرات تشير إلى معرّفات التوكنات (startTokenId .. endTokenId)
 */
export function splitParagraphs(tokens: Token[]): Paragraph[] {
  const words = tokens.filter((t) => t.kind === "word");
  const n = words.length;
  if (n <= 1) return n === 1 ? [{ startTokenId: words[0].id, endTokenId: words[0].id }] : [];

  // 1) الفجوات + تحديد نهايات الجمل
  const isEnd: boolean[] = new Array(n).fill(false);
  const endGaps: number[] = [];
  const allGaps: number[] = [];
  for (let i = 0; i < n; i++) {
    isEnd[i] = isSentenceEnd(words[i]);
    if (i < n - 1) {
      const gap = (words[i + 1].start ?? 0) - (words[i].end ?? 0);
      allGaps.push(gap);
      if (isEnd[i] && gap >= 0) endGaps.push(gap);
    }
  }

  // 2) العتبة التكيّفية: بعد نهايات الجمل إن وُجدت، وإلا كل الفجوات
  const hasEnds = endGaps.length > 0;
  const threshold = hasEnds
    ? percentile([...endGaps].sort((a, b) => a - b), PERCENTILE)
    : percentile([...allGaps].sort((a, b) => a - b), PERCENTILE);

  // 3+4) حدود الفقرات الأولية (مؤشّرات ضمن مصفوفة words)
  const starts: number[] = [0];
  let count = 0;
  for (let i = 0; i < n; i++) {
    count++;
    if (i === n - 1) break;

    const gap = (words[i + 1].start ?? 0) - (words[i].end ?? 0);
    // قاعدة الفجوة: بعد نهاية جملة إن وُجدت، أو أي فجوة طويلة كتراجع
    const gapBreak = (hasEnds ? isEnd[i] : true) && gap >= threshold;
    // السقف: عند 120 كلمة أجبر عند نهاية جملة، أو قطع صلب عند 140
    const ceilingBreak =
      (count >= MAX_PARA_WORDS && isEnd[i]) || count >= HARD_CEILING;

    if (gapBreak || ceilingBreak) {
      starts.push(i + 1);
      count = 0;
    }
  }

  // 5) الأرضية: ادمج الفقرات الأقصر من 25 كلمة مع التالية
  const merged: number[] = [0];
  for (let i = 1; i < starts.length; i++) {
    const prevStart = merged[merged.length - 1];
    const segLen = starts[i] - prevStart;
    if (segLen < MIN_PARA_WORDS && i < starts.length - 1) continue; // ادمج
    merged.push(starts[i]);
  }

  // بناء كائنات الفقرات بمعرّفات التوكنات
  const paragraphs: Paragraph[] = [];
  for (let p = 0; p < merged.length; p++) {
    const s = merged[p];
    const e = p < merged.length - 1 ? merged[p + 1] - 1 : n - 1;
    paragraphs.push({ startTokenId: words[s].id, endTokenId: words[e].id });
  }
  return paragraphs;
}

/**
 * يطبّق تقسيم الفقرات على مستند (يستبدل doc.paragraphs).
 * يحافظ على أي عناوين مرتبطة سابقاً ما دامت معرّفاتها ما زالت صالحة.
 */
export function applyParagraphs(doc: import("./types").TranscriptDocument): void {
  doc.paragraphs = splitParagraphs(doc.tokens);
}
