"use client";

/**
 * ═══════════════════════════════════════════════════════════════
 *  TextEditor.tsx
 *  محرر النصوص التفاعلي — يعرض الكلمات المفرغة مع:
 *    - تحديد كلمة/جملة (Click / Shift+Click)
 *    - حذف ناعم (Strikethrough + Gray) عبر Delete/Backspace
 *    - استعادة كلمة محذوفة (Double-click)
 *    - إبراز الكلمة المشغّلة حالياً
 *    - النقر للقفز لوقت الكلمة
 *    - تلوين الكلمات منخفضة الثقة (Speechmatics confidence)
 * ═══════════════════════════════════════════════════════════════
 */

import { useRef, useCallback, useEffect, useState, useMemo } from "react";
import type { WordState, ConfidenceLevel } from "@/lib/editor-utils";
import {
  formatTimecode,
  formatConfidence,
  confidenceLevel,
  countLowConfidence,
  hasConfidenceData,
} from "@/lib/editor-utils";
import type { Paragraph as DocParagraph } from "@/core/document/types";

interface TextEditorProps {
  words: WordState[];
  /** مؤشرات الكلمات المحددة حالياً */
  selectedIds: Set<number>;
  /** مؤشر الكلمة المشغّلة حالياً */
  playingWordId: number | null;
  /** كلمات مُعلَّمة بخطأ محتمل (wordId → درجة الخطورة) */
  markedWords?: Map<number, string>;
  /**
   * فقرات المستند (plan.md §2.4): عند توفّرها يُعرض النصّ كمجموعات فقرية
   * مع فراغات بصرية وعناوين (إن وُجدت). غيابها = العرض المتواصل القديم
   * (متوافق مع مسار الفيديو).
   */
  paragraphs?: DocParagraph[];
  /** تغيير التحديد */
  onSelectionChange: (ids: Set<number>) => void;
  /** حذف كلمات (Soft Delete) */
  onToggleDelete: (ids: number[]) => void;
  /** تعديل نصّ كلمة (يحتفظ بنفس التوقيت) */
  onEditWord: (id: number, newText: string) => void;
  /** طلب القفز لوقت كلمة */
  onSeekToWord: (time: number) => void;
}

export default function TextEditor({
  words,
  selectedIds,
  playingWordId,
  markedWords,
  paragraphs,
  onSelectionChange,
  onToggleDelete,
  onEditWord,
  onSeekToWord,
}: TextEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [lastClickedId, setLastClickedId] = useState<number | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  // ─── حالة التحرير الإنلاين ──────────────────────────────────
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  // ─── إبراز الكلمات منخفضة الثقة (مفعّل افتراضياً) ────────────
  const [showConfidence, setShowConfidence] = useState(true);

  // درجات الثقة متوفّرة من Speechmatics فقط — نخفي الأداة مع Whisper
  const confidenceAvailable = useMemo(() => hasConfidenceData(words), [words]);
  const confidenceCounts = useMemo(() => countLowConfidence(words), [words]);

  // ─── تقسيم الكلمات إلى فقرات (plan.md §2.4) ─────────────────
  // يحوّل معرّفات التوكنات (w_N) إلى فهارس كلمات، ويُحافظ على ترتيب الكلمات.
  const paragraphGroups = useMemo(() => {
    if (!paragraphs || paragraphs.length === 0) return null;
    const parse = (id: string) => {
      const n = parseInt(id.replace(/^w_/, ""), 10);
      return Number.isFinite(n) ? n : 0;
    };
    const groups = paragraphs
      .map((p) => ({
        start: parse(p.startTokenId),
        end: Math.min(parse(p.endTokenId), words.length - 1),
        heading: p.heading && p.heading.length > 0 ? p.heading : null,
      }))
      .filter((g) => g.end >= g.start);
    return groups.length > 0 ? groups : null;
  }, [paragraphs, words.length]);

  // ─── معالجات النقر ──────────────────────────────────────────

  const handleWordClick = useCallback(
    (e: React.MouseEvent, id: number) => {
      e.stopPropagation();

      if (e.shiftKey && lastClickedId !== null) {
        // Shift+Click: تحديد نطاق
        const start = Math.min(lastClickedId, id);
        const end = Math.max(lastClickedId, id);
        const range = new Set<number>();
        for (let i = start; i <= end; i++) {
          // لا تُحدّد الكلمات المحذوفة في التحديد الجديد
          if (!words[i].deleted) range.add(i);
        }
        onSelectionChange(range);
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+Click: إضافة/إزالة كلمة من التحديد
        const next = new Set(selectedIds);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        onSelectionChange(next);
      } else {
        // نقر مفرد: تحديد + قفز لوقت الكلمة (كمحرّرات التفريغ)
        onSelectionChange(new Set([id]));
        if (!words[id]?.deleted) onSeekToWord(words[id].start);
      }
      setLastClickedId(id);
    },
    [lastClickedId, selectedIds, words, onSelectionChange, onSeekToWord]
  );

  // ─── التحرير الإنلاين ───────────────────────────────────────
  const beginEdit = useCallback((id: number) => {
    setEditingId(id);
    setEditValue(words[id]?.word ?? "");
  }, [words]);

  const commitEdit = useCallback(() => {
    if (editingId === null) return;
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== words[editingId]?.word) {
      onEditWord(editingId, trimmed);
    }
    setEditingId(null);
  }, [editingId, editValue, words, onEditWord]);

  const cancelEdit = useCallback(() => setEditingId(null), []);

  const handleWordDoubleClick = useCallback(
    (id: number) => {
      if (words[id]?.deleted) {
        // استعادة الكلمة المحذوفة
        onToggleDelete([id]);
      } else {
        // تحرير نصّ الكلمة إنلاين
        beginEdit(id);
      }
    },
    [words, onToggleDelete, beginEdit]
  );

  // ─── معالجات لوحة المفاتيح ──────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // تجاهل إذا كان التركيز على حقل إدخال
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedIds.size > 0) {
          e.preventDefault();
          onToggleDelete([...selectedIds]);
          onSelectionChange(new Set());
        }
      } else if (e.key === "Escape") {
        onSelectionChange(new Set());
      } else if (e.ctrlKey && e.key === "a") {
        e.preventDefault();
        const all = new Set<number>();
        words.forEach((w) => {
          if (!w.deleted) all.add(w.id);
        });
        onSelectionChange(all);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedIds, words, onToggleDelete, onSelectionChange]);

  // ─── النقر خارج الكلمات لإلغاء التحديد ──────────────────────
  const handleContainerClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === containerRef.current) {
        onSelectionChange(new Set());
      }
    },
    [onSelectionChange]
  );

  // ─── العرض ──────────────────────────────────────────────────

  const deletedCount = words.filter((w) => w.deleted).length;
  const activeCount = words.length - deletedCount;

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* شريط أدوات المحرر */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-4 text-xs">
          <span className="text-muted">
            <span className="text-foreground font-bold">{activeCount}</span> كلمة
          </span>
          {deletedCount > 0 && (
            <span className="text-danger">
              <span className="font-bold">{deletedCount}</span> محذوفة
            </span>
          )}
          {selectedIds.size > 0 && (
            <span className="text-primary">
              <span className="font-bold">{selectedIds.size}</span> محدّدة
            </span>
          )}

          {/* ─── مفتاح إبراز الثقة المنخفضة ─── */}
          {confidenceAvailable && (
            <button
              onClick={() => setShowConfidence((v) => !v)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border transition-colors ${
                showConfidence
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-border text-muted hover:text-foreground hover:bg-surface-hover"
              }`}
              title={
                showConfidence
                  ? "إخفاء تلوين الكلمات منخفضة الثقة"
                  : "إبراز الكلمات التي شكّ فيها النموذج (درجة الثقة)"
              }
            >
              <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span className="font-bold">
                {confidenceCounts.low + confidenceCounts.medium}
              </span>
              منخفضة الثقة
            </button>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* دليل الألوان */}
          {confidenceAvailable && showConfidence && (
            <div className="flex items-center gap-2.5 text-[10px] text-muted/70">
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-danger/30" />
                &lt;50%
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-accent/30" />
                &lt;80%
              </span>
            </div>
          )}
          <div className="text-[10px] text-muted/60">
            نقر = قفز · نقر مزدوج = تعديل · Delete = حذف
          </div>
        </div>
      </div>

      {/* منطقة النص */}
      <div
        ref={containerRef}
        onClick={handleContainerClick}
        className="flex-1 overflow-y-auto p-5"
        dir="rtl"
      >
        {paragraphGroups ? (
          // عرض الفقرات المتدفّق (plan.md §2.4)
          <div className="text-lg" style={{ lineHeight: "2.4" }}>
            {paragraphGroups.map((g, gi) => (
              <div key={`p-${gi}`} className="mb-5 last:mb-0">
                {g.heading && (
                  <h3 className="text-base font-bold text-primary mb-2 pb-1 border-b border-border/50">
                    {g.heading}
                  </h3>
                )}
                <div>
                  {words.slice(g.start, g.end + 1).map((w) => {
                    if (editingId === w.id) {
                      return (
                        <input
                          key={`edit-${w.id}`}
                          value={editValue}
                          autoFocus
                          dir="rtl"
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitEdit();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              cancelEdit();
                            }
                          }}
                          onBlur={commitEdit}
                          style={{ width: `${Math.max(editValue.length + 2, 4)}ch` }}
                          className="inline-block mx-0.5 px-1.5 py-0.5 rounded bg-surface text-foreground border border-primary outline-none text-lg align-baseline"
                        />
                      );
                    }

                    const isSelected = selectedIds.has(w.id);
                    const isPlaying = playingWordId === w.id;
                    const isHovered = hoveredId === w.id;

                    return (
                      <WordSpan
                        key={w.id}
                        word={w}
                        severity={markedWords?.get(w.id)}
                        confidence={showConfidence ? confidenceLevel(w) : null}
                        isSelected={isSelected}
                        isPlaying={isPlaying}
                        isHovered={isHovered}
                        onClick={(e) => handleWordClick(e, w.id)}
                        onDoubleClick={() => handleWordDoubleClick(w.id)}
                        onMouseEnter={() => setHoveredId(w.id)}
                        onMouseLeave={() => setHoveredId(null)}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          // العرض المتواصل القديم (متوافق مع مسار الفيديو)
          <p className="text-lg leading-loose" style={{ lineHeight: "3" }}>
            {words.map((w) => {
              if (editingId === w.id) {
                return (
                  <input
                    key={`edit-${w.id}`}
                    value={editValue}
                    autoFocus
                    dir="rtl"
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitEdit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                    onBlur={commitEdit}
                    style={{ width: `${Math.max(editValue.length + 2, 4)}ch` }}
                    className="inline-block mx-0.5 px-1.5 py-0.5 rounded bg-surface text-foreground border border-primary outline-none text-lg align-baseline"
                  />
                );
              }

              const isSelected = selectedIds.has(w.id);
              const isPlaying = playingWordId === w.id;
              const isHovered = hoveredId === w.id;

              return (
                <WordSpan
                  key={w.id}
                  word={w}
                  severity={markedWords?.get(w.id)}
                  confidence={showConfidence ? confidenceLevel(w) : null}
                  isSelected={isSelected}
                  isPlaying={isPlaying}
                  isHovered={isHovered}
                  onClick={(e) => handleWordClick(e, w.id)}
                  onDoubleClick={() => handleWordDoubleClick(w.id)}
                  onMouseEnter={() => setHoveredId(w.id)}
                  onMouseLeave={() => setHoveredId(null)}
                />
              );
            })}
          </p>
        )}

        {/* رسالة إذا كان كل شيء محذوف */}
        {activeCount === 0 && words.length > 0 && (
          <div className="text-center py-8 text-muted text-sm">
            جميع الكلمات محذوفة. انقر مزدوجاً على أي كلمة لاستعادتها.
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  مكوّن الكلمة الفردية
// ═══════════════════════════════════════════════════════════════

interface WordSpanProps {
  word: WordState;
  /** درجة خطورة الخطأ إن كانت الكلمة مُعلَّمة (high | medium | low) */
  severity?: string;
  /** تصنيف ثقة النموذج بالكلمة — null = سليمة أو الإبراز مُعطَّل */
  confidence: ConfidenceLevel;
  isSelected: boolean;
  isPlaying: boolean;
  isHovered: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

const WordSpan = ({
  word,
  severity,
  confidence,
  isSelected,
  isPlaying,
  isHovered,
  onClick,
  onDoubleClick,
  onMouseEnter,
  onMouseLeave,
}: WordSpanProps) => {
  // بناء classes بناءً على الحالة
  const baseClasses =
    "inline-block cursor-pointer rounded px-1.5 py-0.5 mx-0.5 transition-all duration-150 select-none relative";

  let stateClasses = "";
  if (word.deleted) {
    // ═══ كلمة محذوفة: خط في الوسط + رمادي ═══
    stateClasses =
      "text-muted/40 line-through decoration-danger/60 decoration-2 hover:text-muted/60 hover:bg-danger/5";
  } else if (isPlaying) {
    // ═══ كلمة مشغّلة: خلفية مميزة ═══
    stateClasses =
      "bg-primary text-white shadow-lg shadow-primary/30 scale-105 z-10";
  } else if (isSelected) {
    // ═══ كلمة محدّدة: إطار أزرق ═══
    stateClasses =
      "bg-primary/20 text-primary ring-1 ring-primary/50";
  } else if (isHovered) {
    // ═══ مرور الفأرة ═══
    stateClasses = "bg-surface-hover text-foreground";
  } else {
    stateClasses = "text-foreground hover:bg-surface-hover";
  }

  // خط متعرّج ملوّن للكلمة المشبوهة (كمدقّق Word) — له الأولوية على مؤشّر التعديل
  const markColor =
    severity === "high"
      ? "decoration-red-500"
      : severity === "low"
      ? "decoration-sky-500"
      : "decoration-amber-500";
  const decoClasses =
    severity && !word.deleted
      ? ` underline decoration-wavy ${markColor} underline-offset-4`
      : word.edited && !word.deleted
      ? " underline decoration-dotted decoration-accent/70 underline-offset-4"
      : "";

  // ═══ إبراز الثقة المنخفضة ═══
  // «قلم تحديد» أسفل الكلمة (تدرّج خلفية في globals.css) — لا يتعارض مع خط
  // المدقّق المتعرّج ولا مع خلفيات التحديد/المرور.
  // يُلغى عند التشغيل لأن خلفية الكلمة المشغّلة مميزة أصلاً.
  const confidenceClasses =
    confidence && !word.deleted && !isPlaying
      ? confidence === "low"
        ? " conf-low"
        : " conf-medium"
      : "";

  // ═══ التلميح ═══
  const titleParts = [formatTimecode(word.start)];
  if (severity) titleParts.push("خطأ محتمل");
  if (word.edited) titleParts.push("مُعدّلة");
  if (typeof word.confidence === "number" && !word.edited) {
    titleParts.push(
      `الثقة ${formatConfidence(word.confidence)}${
        confidence ? " — تحتاج مراجعة" : ""
      }`
    );
  }
  const titleText = titleParts.join(" · ");

  return (
    <span
      className={`${baseClasses} ${stateClasses}${decoClasses}${confidenceClasses}`}
      title={titleText}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-word-id={word.id}
    >
      {word.word}
      {/* نقطة مؤشّر للكلمة المحذوفة */}
      {word.deleted && (
        <span className="absolute -top-0.5 -left-0.5 w-1.5 h-1.5 rounded-full bg-danger/60" />
      )}
    </span>
  );
};
