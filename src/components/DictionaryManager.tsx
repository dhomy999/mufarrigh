"use client";

/**
 * ═══════════════════════════════════════════════════════════════
 *  DictionaryManager.tsx
 *  واجهة إدارة القاموس (plan.md §3.1) — عامة + خاصة بالمشروع.
 *
 *  - مدخل: نصّ أو regex + بديل + حالة الأحرف + ملاحظة.
 *  - إضافة / تعديل / حذف.
 *  - يستدعي onChange بالقائمة الجديدة ليحفظها الأب (settings أو doc).
 * ═══════════════════════════════════════════════════════════════
 */

import { useState } from "react";
import { genDictId, type DictionaryEntry } from "@/core/document";

interface DictionaryManagerProps {
  /** عنوان النافذة */
  title: string;
  /** المدخلات الحالية */
  entries: DictionaryEntry[];
  /** يُستدعى عند تغيّر القائمة */
  onChange: (next: DictionaryEntry[]) => void;
  /** إغلاق */
  onClose: () => void;
}

export default function DictionaryManager({
  title,
  entries,
  onChange,
  onClose,
}: DictionaryManagerProps) {
  const [match, setMatch] = useState("");
  const [replacement, setReplacement] = useState("");
  const [kind, setKind] = useState<"text" | "regex">("text");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const reset = () => {
    setMatch("");
    setReplacement("");
    setKind("text");
    setCaseSensitive(false);
    setNote("");
    setError(null);
    setEditingId(null);
  };

  const handleSubmit = () => {
    setError(null);
    if (!match.trim()) {
      setError("أدخل ما تريد البحث عنه");
      return;
    }
    if (kind === "regex") {
      try {
        new RegExp(match);
      } catch (e) {
        setError(`تعبير منتظم غير صالح: ${(e as Error).message}`);
        return;
      }
    }
    if (editingId) {
      onChange(
        entries.map((e) =>
          e.id === editingId
            ? { ...e, match, replacement, kind, caseSensitive, note }
            : e
        )
      );
    } else {
      const next: DictionaryEntry = {
        id: genDictId(),
        match,
        replacement,
        kind,
        caseSensitive,
        note: note.trim() || undefined,
      };
      onChange([...entries, next]);
    }
    reset();
  };

  const handleEdit = (e: DictionaryEntry) => {
    setMatch(e.match);
    setReplacement(e.replacement);
    setKind(e.kind);
    setCaseSensitive(!!e.caseSensitive);
    setNote(e.note ?? "");
    setEditingId(e.id);
  };

  const handleDelete = (id: string) => {
    onChange(entries.filter((e) => e.id !== id));
    if (editingId === id) reset();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-surface rounded-xl border border-border shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 className="text-base font-bold text-foreground">{title}</h2>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted hover:text-foreground hover:bg-surface-hover"
            title="إغلاق"
          >
            ✕
          </button>
        </header>

        <div className="px-5 py-3 border-b border-border bg-background/40 shrink-0">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto_auto] gap-2 items-end">
            <Field label="بحث (نصّ أو نمط)">
              <input
                value={match}
                onChange={(e) => setMatch(e.target.value)}
                placeholder={kind === "regex" ? "^[اأ]ل" : "محمد"}
                dir="rtl"
                className="w-full px-2.5 py-1.5 rounded-md bg-background border border-border text-sm focus:outline-none focus:border-primary"
              />
            </Field>
            <Field label="استبدال بـ">
              <input
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                placeholder="الاسم الصحيح"
                dir="rtl"
                className="w-full px-2.5 py-1.5 rounded-md bg-background border border-border text-sm focus:outline-none focus:border-primary"
              />
            </Field>
            <Field label="النوع">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as "text" | "regex")}
                className="px-2 py-1.5 rounded-md bg-background border border-border text-sm focus:outline-none focus:border-primary"
              >
                <option value="text">نصّ</option>
                <option value="regex">Regex</option>
              </select>
            </Field>
            <button
              onClick={handleSubmit}
              className="px-3 py-1.5 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
            >
              {editingId ? "حفظ التعديل" : "إضافة"}
            </button>
          </div>
          <div className="flex items-center gap-4 mt-2">
            <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
                className="accent-primary"
              />
              حسّاس لحالة الأحرف
            </label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="ملاحظة (اختياري)"
              dir="rtl"
              className="flex-1 px-2 py-1 rounded-md bg-background border border-border text-xs focus:outline-none focus:border-primary"
            />
          </div>
          {error && (
            <div className="text-xs text-danger mt-2">{error}</div>
          )}
          {editingId && (
            <button
              onClick={reset}
              className="text-[11px] text-muted hover:text-foreground mt-1"
            >
              إلغاء التعديل
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {entries.length === 0 ? (
            <div className="text-center text-muted text-sm py-8">
              القاموس فارغ. أضف كلمات أو أنماطاً لتُطبَّق على التفريغ قبل
              التصدير (وأثناء التفريغ لمزوّد Speechmatics).
            </div>
          ) : (
            <ul className="space-y-1.5">
              {entries.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-background border border-border hover:border-primary/40 transition-colors"
                >
                  <div className="flex-1 min-w-0" dir="rtl">
                    <div className="flex items-center gap-2 text-sm">
                      <code className="px-1.5 py-0.5 rounded bg-surface-hover text-foreground truncate max-w-[40%]">
                        {e.match}
                      </code>
                      <span className="text-muted">←</span>
                      <code className="px-1.5 py-0.5 rounded bg-primary/10 text-primary truncate max-w-[40%]">
                        {e.replacement || "(حذف)"}
                      </code>
                      <span className="text-[10px] px-1 rounded bg-surface-hover text-muted">
                        {e.kind}
                      </span>
                      {e.caseSensitive && (
                        <span className="text-[10px] px-1 rounded bg-surface-hover text-muted">
                          Aa
                        </span>
                      )}
                    </div>
                    {e.note && (
                      <div className="text-[11px] text-muted mt-0.5">{e.note}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleEdit(e)}
                      className="px-2 py-1 text-xs text-muted hover:text-foreground rounded hover:bg-surface-hover"
                    >
                      تعديل
                    </button>
                    <button
                      onClick={() => handleDelete(e.id)}
                      className="px-2 py-1 text-xs text-danger hover:bg-danger/10 rounded"
                    >
                      حذف
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="px-5 py-2.5 border-t border-border text-[11px] text-muted shrink-0">
          يُطبَّق القاموس تلقائياً بعد التفريغ (يستبدل في نصّ كل كلمة) ويُمرَّر
          إلى Speechmatics كـ <code>additional_vocab</code> قبل بدء التفريغ.
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] text-muted mb-1">{label}</span>
      {children}
    </label>
  );
}