/**
 * ═══════════════════════════════════════════════════════════════
 *  core/document/types.ts
 *  نموذج المستند الموحّد (TranscriptDocument) — النواة المشتركة
 *
 *  كل تفريغ يُمثَّل كتدفّق توكِنات واحد. السطحان (TextStudio /
 *  VideoStudio) يقرآن نفس المخزن ويعرضانه ويصدّرانه بطريقتين
 *  مختلفتين — بلا نسخ كود ولا تشعّب في البيانات.
 *
 *  راجع plan.md §2.2 (نموذج التوكِن).
 * ═══════════════════════════════════════════════════════════════
 */

/** نوع التوكِن: كلمة / علامة ترقيم / فاصل فقرة */
export type TokenKind = "word" | "punct" | "break";

/** حالة التوكِن: نشط أو مستبعد (حذف ناعم) */
export type TokenStatus = "active" | "removed";

/** مصدر التوكِن: تفريغ آلي / يدوي / ذكاء اصطناعي / قاموس */
export type TokenOrigin = "asr" | "user" | "ai" | "dict";

/**
 * التوكِن — وحدة بناء المستند الواحدة.
 *
 * - الكلمات تحمل `start`/`end` (طوابع زمنية).
 * - علامات الترقيم والفواصل بلا زمن (اختياري) — يقرأها مصدّر النصّ
 *   ويتجاهلها مصدّر الفيديو تلقائياً.
 * - `removed` صالحة في المسارين: حذف حشو في وضع النصّ يصير قصّاً مفيداً
 *   إن صُدِّر فيديو لاحقاً.
 */
export interface Token {
  /** معرّف ثابت للتوكِن (مثل w_42) — يُحفظ عبر الجلسات */
  id: string;
  kind: TokenKind;
  /** النصّ المعروض (قد يختلف عن originalText بعد التحرير) */
  text: string;
  /** بداية التوكن بالثواني — بلا زمن للترقيم والفواصل */
  start?: number;
  /** نهاية التوكن بالثواني */
  end?: number;
  /** درجة ثقة النموذج (0..1) — من Speechmatics فقط */
  confidence?: number;
  /** المُتحدّث (S1, S2 …) — اختياري، مؤجَّل للمرحلة ٥ */
  speaker?: string;
  status: TokenStatus;
  origin: TokenOrigin;
  /** النصّ الأصلي قبل التحرير اليدوي — للتراجع */
  originalText?: string;
}

/** فقرة: نطاق توكِنات مع عنوان اختياري */
export interface Paragraph {
  startTokenId: string;
  endTokenId: string;
  heading?: string;
}

/**
 * مدخل قاموس (plan.md §3.1):
 *  - عام: يُحفَظ في إعدادات التطبيق (settings.dictionary).
 *  - خاص بالمشروع: يُحفَظ داخل TranscriptDocument.dictionary.
 *
 *  الاستبدال:
 *    text  → تطابق نصّي حرفي (substring)
 *    regex → نمط تعبير منتظم (RegExp)
 *
 *  للإضافة إلى `additional_vocab` (Speechmatics) قبل التفريغ:
 *    تُستخدم مدخلات `text` فقط وبـ content = replacement
 *    (الاسم الصحيح للنموذج)، فتساعد على نطقه وكتابته.
 */
export interface DictionaryEntry {
  id: string;
  /** ما نبحث عنه (نصّ أو نمط) */
  match: string;
  /** ما نستبدله به */
  replacement: string;
  kind: "text" | "regex";
  caseSensitive?: boolean;
  /** وصف اختياري يظهر للمستخدم في واجهة القاموس */
  note?: string;
}

/** بيانات وصفية للمستند */
export interface DocumentMeta {
  /** نوع المصدر: صوت أو فيديو */
  sourceKind: "audio" | "video";
  /** مدّة المصدر بالثواني */
  duration: number;
  /** المزوّد الذي أنتج التفريغ (groq/openai/speechmatics…) */
  provider: string;
  /** لغة التفريغ (ar…) — اختياري */
  language?: string;
}

/**
 * المستند الموحّد — النواة المشتركة بين المسارين.
 */
export interface TranscriptDocument {
  tokens: Token[];
  paragraphs: Paragraph[];
  /** أسماء المتحدّثين (اختياري — مؤجَّل للمرحلة ٥) */
  speakers?: Record<string, string>;
  meta: DocumentMeta;
  /** قاموس خاص بهذا المشروع (plan.md §3.1) */
  dictionary?: DictionaryEntry[];
}
