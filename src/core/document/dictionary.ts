/**
 * ═══════════════════════════════════════════════════════════════
 *  core/document/dictionary.ts
 *  طبقة القاموس والتصحيح (plan.md §3.1)
 *
 *  وظيفتان:
 *    1) applyDictionary(tokens, entries): تستبدل في نصّ الكلمات.
 *    2) buildAdditionalVocab(entries): تستخرج الكلمات لإرسالها
 *       إلى Speechmatics كـ `additional_vocab` قبل التفريغ
 *       (لا بعده فقط) — هذا هو مكسب الخطة الحر.
 * ═══════════════════════════════════════════════════════════════
 */

import type { Token, DictionaryEntry } from "./types";

/** يستبدل نصّ التوكِنات وفق قاموس معيّن ويُرجع قائمة بالتعديلات */
export interface DictionaryChange {
  tokenId: string;
  before: string;
  after: string;
  entryId: string;
}

/** يستبدل نصّ بحسب قاموس معيّن ويُرجع (نصّ جديد | مُدخل كما هو عند عدم التغيّر) */
export function applyToText(text: string, entries: DictionaryEntry[]): string {
  let out = text;
  let changed = false;
  for (const e of entries) {
    if (!e.match) continue;
    try {
      if (e.kind === "regex") {
        const re = new RegExp(e.match, e.caseSensitive ? "g" : "gi");
        const next = out.replace(re, e.replacement);
        if (next !== out) {
          out = next;
          changed = true;
        }
      } else {
        const needle = e.match;
        const hay = e.caseSensitive ? out : out.toLowerCase();
        const lowNeedle = e.caseSensitive ? needle : needle.toLowerCase();
        if (hay.includes(lowNeedle)) {
          // استبدال حسّاس لحالة الأحرف بشكل صحيح
          out = e.caseSensitive
            ? out.split(needle).join(e.replacement)
            : out.replace(new RegExp(escapeRegex(needle), "gi"), e.replacement);
          changed = true;
        }
      }
    } catch {
      // تجاهل المدخلات الخاطئة (regex غير صالح) بصمت
    }
  }
  return changed ? out : text;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * يطبّق القاموس على توكِنات (كلمات فقط — الترقيم والفواصل بلا نصّ بديل).
 * يُحدّث `text` ويترك `originalText` كما هو (للتراجع).
 */
export function applyDictionary(
  tokens: Token[],
  entries: DictionaryEntry[]
): DictionaryChange[] {
  if (entries.length === 0) return [];
  const changes: DictionaryChange[] = [];
  for (const t of tokens) {
    if (t.kind !== "word") continue;
    if (t.status === "removed") continue;
    const next = applyToText(t.text, entries);
    if (next !== t.text) {
      changes.push({ tokenId: t.id, before: t.text, after: next, entryId: "" });
      t.text = next;
      t.origin = "dict";
    }
  }
  // املأ entryId بأفضل مطابقة (للتتبّع)
  for (const c of changes) {
    const e = entries.find((en) => {
      try {
        if (en.kind === "regex") return new RegExp(en.match, en.caseSensitive ? "g" : "gi").test(c.before);
        const needle = en.caseSensitive ? en.match : en.match.toLowerCase();
        const hay = en.caseSensitive ? c.before : c.before.toLowerCase();
        return hay.includes(needle);
      } catch {
        return false;
      }
    });
    if (e) c.entryId = e.id;
  }
  return changes;
}

/**
 * يبني قائمة النصوص التي تُضاف إلى `additional_vocab` لمزوّد
 * Speechmatics (نمرّر `replacement` لا `match` لِيُنطق الاسم الصحيح).
 * regex تُتجاهل هنا (لا تُترجم إلى vocab).
 */
export function buildAdditionalVocab(entries: DictionaryEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "text") continue;
    const v = e.replacement.trim();
    if (v.length > 0) set.add(v);
  }
  return [...set];
}

/** معرّف فريد لعنصر قاموس جديد */
export function genDictId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fallthrough */
  }
  return `dict-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}