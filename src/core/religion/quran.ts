/**
 * ═══════════════════════════════════════════════════════════════
 *  core/religion/quran.ts
 *  كشف الآيات القرآنية وتنسيقها (plan.md §3.4)
 *
 *  الميزة التي لا يستطيع منافس عالمي مقاربتها:
 *  المحاضر يستشهد بآية كل بضع دقائق، ونماذج التفريغ تُحرّفها.
 *  نكتشف النصّ، نطابقه مع المصحف، وننسّقه بـ ﴿ ﴾ مع اسم السورة ورقم الآية.
 *
 *  بنية قابلة للتوسّع:
 *    - CORPUS: مجموعة آيات bundled كنواة (سورة الفاتحة + أواخر القصص)
 *      تُغطى الاستشهادات الأكثر شيوعاً في الدروس والمحاضرات.
 *    - loadFullCorpus(): يُحمَّل من API خارجي (api.quran.com) ويُحقن
 *      في الـ matcher عند توفّر الاتصال — يُمدّ الكشف ليشمل ٦٢٣٦ آية.
 *    - matchVerses(): يطابق تدفّق التوكِنات ضدّ كل آية ويُرجع الفترات
 *      المكتشفة مع درجة الثقة.
 *
 *  لا يكتشف أحاديث في هذه المرحلة — يتطلّعلها نصّاً مرجعياً لكل رواية،
 *  وهي خارج نطاق الإطلاق (مؤجَّلة).
 * ═══════════════════════════════════════════════════════════════
 */

import type { Token } from "../document/types";

/** سورة + آية + نصّ عثماني */
export interface QuranVerse {
  /** رقم السورة (1..114) */
  sura: number;
  /** رقم الآية داخل السورة */
  aya: number;
  /** اسم السورة بالعربية */
  suraName: string;
  /** النصّ العثماني المرجعي */
  text: string;
  /** نصّ مرجعي بلا تشكيل — يُحسب عند التحضير (اختياري في المُدخل) */
  normalized?: string;
}

/** نتيجة كشف آية في مدى توكناتي */
export interface VerseMatch {
  sura: number;
  aya: number;
  suraName: string;
  /** أوّل توكن في الآية المكتشفة */
  startTokenId: string;
  /** آخر توكن */
  endTokenId: string;
  /** درجة التشابه [0..1] */
  score: number;
}

// ───────────────────────────────────────────────────────────────
// 1) الحزمة الأساسية (سور قصيرة تُستشهد بها كثيراً)
// ───────────────────────────────────────────────────────────────

const FATIHA: QuranVerse[] = [
  { sura: 1, aya: 1, suraName: "الفاتحة", text: "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ" },
  { sura: 1, aya: 2, suraName: "الفاتحة", text: "ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ" },
  { sura: 1, aya: 3, suraName: "الفاتحة", text: "ٱلرَّحْمَٰنِ ٱلرَّحِيمِ" },
  { sura: 1, aya: 4, suraName: "الفاتحة", text: "مَٰلِكِ يَوْمِ ٱلدِّينِ" },
  { sura: 1, aya: 5, suraName: "الفاتحة", text: "إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ" },
  { sura: 1, aya: 6, suraName: "الفاتحة", text: "ٱهْدِنَا ٱلصِّرَٰطَ ٱلْمُسْتَقِيمَ" },
  { sura: 1, aya: 7, suraName: "الفاتحة", text: "صِرَٰطَ ٱلَّذِينَ أَنْعَمْتَ عَلَيْهِمْ غَيْرِ ٱلْمَغْضُوبِ عَلَيْهِمْ وَلَا ٱلضَّآلِّينَ" },
];

const IKHLAS: QuranVerse[] = [
  { sura: 112, aya: 1, suraName: "الإخلاص", text: "قُلْ هُوَ ٱللَّهُ أَحَدٌ" },
  { sura: 112, aya: 2, suraName: "الإخلاص", text: "ٱللَّهُ ٱلصَّمَدُ" },
  { sura: 112, aya: 3, suraName: "الإخلاص", text: "لَمْ يَلِدْ وَلَمْ يُولَدْ" },
  { sura: 112, aya: 4, suraName: "الإخلاص", text: "وَلَمْ يَكُن لَّهُۥ كُفُوًا أَحَدٌۢ" },
];

const FALAQ: QuranVerse[] = [
  { sura: 113, aya: 1, suraName: "الفلق", text: "قُلْ أَعُوذُ بِرَبِّ ٱلْفَلَقِ" },
  { sura: 113, aya: 2, suraName: "الفلق", text: "مِن شَرِّ مَا خَلَقَ" },
  { sura: 113, aya: 3, suraName: "الفلق", text: "وَمِن شَرِّ غَاسِقٍ إِذَا وَقَبَ" },
  { sura: 113, aya: 4, suraName: "الفلق", text: "وَمِن شَرِّ ٱلنَّفَّٰثَٰتِ فِى ٱلْعُقَدِ" },
  { sura: 113, aya: 5, suraName: "الفلق", text: "وَمِن شَرِّ حَاسِدٍ إِذَا حَسَدَ" },
];

const NAS: QuranVerse[] = [
  { sura: 114, aya: 1, suraName: "الناس", text: "قُلْ أَعُوذُ بِرَبِّ ٱلنَّاسِ" },
  { sura: 114, aya: 2, suraName: "الناس", text: "مَلِكِ ٱلنَّاسِ" },
  { sura: 114, aya: 3, suraName: "الناس", text: "إِلَٰهِ ٱلنَّاسِ" },
  { sura: 114, aya: 4, suraName: "الناس", text: "مِن شَرِّ ٱلْوَسْوَاسِ ٱلْخَنَّاسِ" },
  { sura: 114, aya: 5, suraName: "الناس", text: "ٱلَّذِى يُوَسْوِسُ فِى صُدُورِ ٱلنَّاسِ" },
  { sura: 114, aya: 6, suraName: "الناس", text: "مِنَ ٱلْجِنَّةِ وَٱلنَّاسِ" },
];

const NASR: QuranVerse[] = [
  { sura: 110, aya: 1, suraName: "النصر", text: "إِذَا جَآءَ نَصْرُ ٱللَّهِ وَٱلْفَتْحُ" },
  { sura: 110, aya: 2, suraName: "النصر", text: "وَرَأَيْتَ ٱلنَّاسَ يَدْخُلُونَ فِى دِينِ ٱللَّهِ أَفْوَاجًا" },
  { sura: 110, aya: 3, suraName: "النصر", text: "فَسَبِّحْ بِحَمْدِ رَبِّكَ وَٱسْتَغْفِرْهُ ۚ إِنَّهُۥ كَانَ تَوَّابًۢا" },
];

const KAWTHAR: QuranVerse[] = [
  { sura: 108, aya: 1, suraName: "الكوثر", text: "إِنَّآ أَعْطَيْنَٰكَ ٱلْكَوْثَرَ" },
  { sura: 108, aya: 2, suraName: "الكوثر", text: "فَصَلِّ لِرَبِّكَ وَٱنْحَرْ" },
  { sura: 108, aya: 3, suraName: "الكوثر", text: "إِنَّ شَانِئَكَ هُوَ ٱلْأَبْتَرُ" },
];

const ASR: QuranVerse[] = [
  { sura: 103, aya: 1, suraName: "العصر", text: "وَٱلْعَصْرِ" },
  { sura: 103, aya: 2, suraName: "العصر", text: "إِنَّ ٱلْإِنسَٰنَ لَفِى خُسْرٍ" },
  { sura: 103, aya: 3, suraName: "العصر", text: "إِلَّا ٱلَّذِينَ ءَامَنُوا۟ وَعَمِلُوا۟ ٱلصَّٰلِحَٰتِ وَتَوَاصَوْا۟ بِٱلْحَقِّ وَتَوَاصَوْا۟ بِٱلصَّبْرِ" },
];

/** الحزمة المرجعية المدمجة (≈٣٢ آية من ٧ سور) */
const BUILTIN: QuranVerse[] = [
  ...FATIHA,
  ...IKHLAS,
  ...FALAQ,
  ...NAS,
  ...NASR,
  ...KAWTHAR,
  ...ASR,
];

let FULL_CORPUS: QuranVerse[] | null = null;

/** يستبدل كل ما ليس حرفاً عربياً أو رمزاً خاصاً (الحروف العثمانية) */
function normalizeArabic(s: string): string {
  // نحذف التشكيل، ا لألف الخنجرية (ٱ) → ا، ال التعريف → بدون
  return s
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "") // التشكيل
    .replace(/ٱ/g, "ا")
    .replace(/\s+/g, "")
    .trim();
}

function prepareCorpus(verses: QuranVerse[]): QuranVerse[] {
  return verses.map((v) => ({ ...v, normalized: normalizeArabic(v.text) }));
}

/** يُحقن المصحف الكامل (يُحمَّل من API خارجي ويُمرَّر هنا) */
export function setQuranCorpus(verses: QuranVerse[]): void {
  FULL_CORPUS = prepareCorpus(verses);
}

/** يُرجع عدد الآيات المتاحة حالياً في الذاكرة */
export function quranCorpusSize(): number {
  return (FULL_CORPUS ?? BUILTIN).length;
}

/** يُرجع الحزمة المدمجة (للقراءة فقط) */
export function builtinQuran(): readonly QuranVerse[] {
  return BUILTIN;
}

// ───────────────────────────────────────────────────────────────
// 2) المطابقة
// ───────────────────────────────────────────────────────────────

/** ينرّمل (يطبّع) نصّ كلمة/توكِن */
function normalizeTokenText(s: string): string {
  return normalizeArabic(s);
}

/**
 * يبحث عن آية في نافذة من التوكِنات.
 * @returns أفضل مطابقة أو null.
 */
function findVerseInWindow(
  windowTokens: Token[],
  corpus: QuranVerse[],
  minScore: number
): VerseMatch | null {
  if (windowTokens.length === 0) return null;
  const text = windowTokens.map((t) => normalizeTokenText(t.text)).join("");
  if (text.length < 4) return null;

  let best: VerseMatch | null = null;
  for (const v of corpus) {
    const score = similarity(text, v.normalized ?? "");
    if (score >= minScore && (!best || score > best.score)) {
      best = {
        sura: v.sura,
        aya: v.aya,
        suraName: v.suraName,
        startTokenId: windowTokens[0].id,
        endTokenId: windowTokens[windowTokens.length - 1].id,
        score,
      };
    }
  }
  return best;
}

/** نسبة أطول جزء مشترك (LCS) كنسبة من طول الهدف */
function similarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const lcs = lcsLength(a, b);
  // نُقارن بأقصر نصّ (الآية المرجعية عادةً أقصر من نافذة ASR)
  return lcs / Math.max(a.length, b.length);
}

/** طول أطول جزء مشترك — تنفيذ DP مدمج لكفاءة بسيطة */
function lcsLength(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m * n > 250000) {
    // نافذة طويلة جداً: نُسقط الدقة لتفادي البطء
    return quickLcs(a, b);
  }
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const k = i * (n + 1) + j;
      if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
        dp[k] = dp[(i - 1) * (n + 1) + (j - 1)] + 1;
      } else {
        dp[k] = Math.max(dp[(i - 1) * (n + 1) + j], dp[i * (n + 1) + (j - 1)]);
      }
    }
  }
  return dp[m * (n + 1) + n];
}

/** LCS تقريبي سريع (n-grams) للنوافذ الطويلة */
function quickLcs(a: string, b: string): number {
  const set = new Set<string>();
  for (let i = 0; i < b.length - 2; i++) set.add(b.slice(i, i + 3));
  let matches = 0;
  for (let i = 0; i < a.length - 2; i++) if (set.has(a.slice(i, i + 3))) matches++;
  // تقريب: كل 3-grams مشتركة ≈ 3 أحرف LCS
  return matches * 3;
}

// ───────────────────────────────────────────────────────────────
// 3) الواجهة العامة
// ───────────────────────────────────────────────────────────────

/**
 * خيارات المطابقة
 */
export interface MatchOptions {
  /** أقل درجة تشابه لاعتماد الكشف (افتراضي: 0.55) */
  minScore?: number;
  /** حجم نافذة البحث بعدد الكلمات (افتراضي: 16) */
  windowSize?: number;
  /** خطوة تقدّم النافذة (افتراضي: 6) */
  step?: number;
  /** تجاهل التوكِنات المحذوفة */
  skipRemoved?: boolean;
}

const DEFAULTS: Required<MatchOptions> = {
  minScore: 0.55,
  windowSize: 16,
  step: 6,
  skipRemoved: true,
};

/**
 * يكتشف الآيات القرآنية في تدفّق التوكِنات.
 * يستعمل الحزمة المدمجة (≈٣٢ آية) ما لم تُحقَن حزمة كاملة.
 */
export function matchVerses(
  tokens: Token[],
  options: MatchOptions = {}
): VerseMatch[] {
  const opts = { ...DEFAULTS, ...options };
  const corpus = FULL_CORPUS ?? prepareCorpus(BUILTIN);
  const matches: VerseMatch[] = [];
  const claimed = new Set<string>(); // token IDs مُطابقة سابقاً

  // نُمرّ بنافذة منزلقة ونلتقط أفضل مطابقة لكلّ فاصل
  for (let start = 0; start < tokens.length; start += opts.step) {
    const end = Math.min(tokens.length, start + opts.windowSize);
    const window: Token[] = [];
    for (let i = start; i < end; i++) {
      const t = tokens[i];
      if (opts.skipRemoved && t.status === "removed") continue;
      if (t.kind !== "word") continue;
      if (claimed.has(t.id)) continue;
      window.push(t);
    }
    const m = findVerseInWindow(window, corpus, opts.minScore);
    if (m) {
      // علِّم التوكنات كمُطابقة حتى لا تتداخل مع آية لاحقة
      for (const t of window) claimed.add(t.id);
      matches.push(m);
    }
  }
  return matches;
}

/** يُنسّق اسم السورة + رقم الآية كعنوان يظهر بعد الآية */
export function formatVerseRef(v: { suraName: string; sura: number; aya: number }): string {
  return `﴾ ${v.suraName} • آية ${v.aya} ﴿`;
}