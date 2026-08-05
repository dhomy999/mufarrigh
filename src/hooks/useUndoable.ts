"use client";

import { useCallback, useState } from "react";

/**
 * ═══════════════════════════════════════════════════════════════
 *  useUndoable.ts
 *  حالة قابلة للتراجع والإعادة على مستوى العمليات (plan.md §0.4)
 *
 *  تحتفظ بثلاث طبقات: ماضٍ (past) وحاضر (present) ومستقبل (future).
 *  كل تحديث يدفع الحاضر الحالي إلى الماضي ويُفرغ المستقبل.
 *  undo/redo تنقل قيمة بين الطبقات.
 *
 *  مستوى التراجع = العملية الواحدة (حذف، تعديل، قبول تصحيح…).
 * ═══════════════════════════════════════════════════════════════
 */

interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

/** سقف لعدد الخطوات المحفوظة لتفادي نموّ الذاكرة بلا حدود */
const MAX_HISTORY = 200;

export interface Undoable<T> {
  /** القيمة الحالية */
  value: T;
  /** تحديث بقيمة جديدة أو دالة محدِّثة (يدفع الحاضر السابق للتاريخ) */
  set: (updater: T | ((prev: T) => T)) => void;
  undo: () => void;
  redo: () => void;
  /** إعادة ضبط بقيمة جديدة ومسح التاريخ كاملاً */
  reset: (value: T | ((prev: T) => T)) => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useUndoable<T>(initial: T | (() => T)): Undoable<T> {
  const [hist, setHist] = useState<History<T>>(() => {
    const present =
      typeof initial === "function"
        ? (initial as () => T)()
        : initial;
    return { past: [], present, future: [] };
  });

  const set = useCallback((updater: T | ((prev: T) => T)) => {
    setHist((h) => {
      const next =
        typeof updater === "function"
          ? (updater as (p: T) => T)(h.present)
          : updater;
      // لا تنشئ خطوة إن لم يتغيّر شيء
      if (Object.is(next, h.present)) return h;
      // سقف للتاريخ: نُسقط الأقدم عند بلوغ الحدّ
      const past =
        h.past.length >= MAX_HISTORY ? h.past.slice(1) : h.past;
      return { past: [...past, h.present], present: next, future: [] };
    });
  }, []);

  const undo = useCallback(() => {
    setHist((h) => {
      if (h.past.length === 0) return h;
      const previous = h.past[h.past.length - 1];
      return {
        past: h.past.slice(0, -1),
        present: previous,
        future: [h.present, ...h.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHist((h) => {
      if (h.future.length === 0) return h;
      const next = h.future[0];
      return {
        past: [...h.past, h.present],
        present: next,
        future: h.future.slice(1),
      };
    });
  }, []);

  const reset = useCallback((value: T | ((prev: T) => T)) => {
    setHist((h) => {
      const next =
        typeof value === "function"
          ? (value as (p: T) => T)(h.present)
          : value;
      return { past: [], present: next, future: [] };
    });
  }, []);

  return {
    value: hist.present,
    set,
    undo,
    redo,
    reset,
    canUndo: hist.past.length > 0,
    canRedo: hist.future.length > 0,
  };
}
