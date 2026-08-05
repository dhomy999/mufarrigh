"use client";

/**
 * ═══════════════════════════════════════════════════════════════
 *  SpeakersPanel.tsx
 *  فصل المتحدثين + لوحة التسمية (plan.md §5.1)
 *
 *  يكتشف معرّفات المتحدثين الفريدة (S1, S2…) في المستند،
 *  يعرض حقول تسمية، ويحفظ الأسماء في doc.speakers.
 *
 *  ملاحظة: الكشف الآلي عن المتحدثين (diarization) مؤجَّل —
 *  يحتاج خطّ أنابيب ML (pyannote…) يتجاوز نطاق هذه المرحلة.
 *  اللوحة تتعامل مع المعرّفات الموجودة وتُسمّيها.
 * ═══════════════════════════════════════════════════════════════
 */

import { useMemo, useState } from "react";
import type { TranscriptDocument } from "@/core/document";

interface SpeakersPanelProps {
  doc: TranscriptDocument;
  onSpeakersChange: (speakers: Record<string, string>) => void;
  onClose: () => void;
}

export default function SpeakersPanel({
  doc,
  onSpeakersChange,
  onClose,
}: SpeakersPanelProps) {
  // المعرّفات الفريدة من التوكِنات (مرتّبة حسب أول ظهور)
  const speakerIds = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const t of doc.tokens) {
      if (t.speaker && !seen.has(t.speaker)) {
        seen.add(t.speaker);
        ordered.push(t.speaker);
      }
    }
    return ordered;
  }, [doc.tokens]);

  const [speakers, setSpeakers] = useState<Record<string, string>>(
    () => ({ ...(doc.speakers ?? {}) })
  );

  const update = (id: string, name: string) => {
    const next = { ...speakers };
    if (name.trim()) next[id] = name.trim();
    else delete next[id];
    setSpeakers(next);
    onSpeakersChange(next);
  };

  const countBySpeaker = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of doc.tokens) if (t.speaker) c[t.speaker] = (c[t.speaker] ?? 0) + 1;
    return c;
  }, [doc.tokens]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-surface rounded-xl border border-border shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 className="text-base font-bold text-foreground">المتحدّثون</h2>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted hover:text-foreground hover:bg-surface-hover"
          >
            ✕
          </button>
        </header>

        <div className="px-5 py-4 flex-1 overflow-y-auto">
          {speakerIds.length === 0 ? (
            <div className="text-center text-muted text-sm py-8 space-y-2">
              <p>لم يُكشف متحدّثون في هذا المستند بعد.</p>
              <p className="text-[11px] text-muted/70">
                الكشف الآلي (diarization) يتطلب خطّ أنابيب ML خارجي —
                سيُضاف لاحقاً. اللوحة جاهزة لتسمية أي معرّفات س1/س2… تظهر.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {speakerIds.map((id) => (
                <li key={id} className="flex items-center gap-2">
                  <span className="text-[11px] font-mono text-muted bg-background border border-border px-2 py-1 rounded shrink-0 min-w-[40px] text-center">
                    {id}
                  </span>
                  <input
                    value={speakers[id] ?? ""}
                    onChange={(e) => update(id, e.target.value)}
                    placeholder="اسم المتحدث (مثال: الشيخ محمد)"
                    dir="rtl"
                    className="flex-1 px-3 py-1.5 rounded-md bg-background border border-border text-sm focus:outline-none focus:border-primary"
                  />
                  <span className="text-[10px] text-muted tabular-nums shrink-0" title="عدد الكلمات">
                    {countBySpeaker[id] ?? 0}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="px-5 py-2.5 border-t border-border text-[11px] text-muted shrink-0">
          الأسماء تُحفظ مع المستند وتظهر في التصدير.
        </footer>
      </div>
    </div>
  );
}