"use client";

/**
 * ═══════════════════════════════════════════════════════════════
 *  UpdateManager.tsx
 *  تدفّقان مرتبطان بالإصدار:
 *    1. «ما الجديد» — يظهر مرة واحدة بعد كل ترقية (لا عند أول تثبيت)
 *    2. «يتوفّر تحديث» — شريط غير معطِّل، ثم تنزيل بمؤشّر تقدّم
 *
 *  الترتيب مقصود: تُعرض «ما الجديد» أولاً وتُؤجَّل رسالة التحديث
 *  حتى تُغلق، فلا يواجه المستخدم نافذتين معاً.
 * ═══════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useState } from "react";
import {
  checkForUpdate,
  installUpdate,
  currentVersion,
  consumeVersionChange,
  skipVersion,
  type AvailableUpdate,
  type DownloadProgress,
} from "@/lib/updater";
import { entryFor, type ChangelogEntry } from "@/lib/changelog";

/** تأخير الفحص عن التحديث حتى يستقرّ بدء التطبيق */
const CHECK_DELAY_MS = 4000;

const KIND_LABEL: Record<ChangelogEntry["changes"][number]["kind"], string> = {
  new: "جديد",
  improve: "تحسين",
  fix: "إصلاح",
};

const KIND_CLASS: Record<ChangelogEntry["changes"][number]["kind"], string> = {
  new: "bg-success/15 text-success border-success/30",
  improve: "bg-primary/15 text-primary border-primary/30",
  fix: "bg-accent/15 text-accent border-accent/30",
};

export default function UpdateManager() {
  const [whatsNew, setWhatsNew] = useState<ChangelogEntry | null>(null);
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── 1. «ما الجديد» بعد الترقية ───────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const version = await currentVersion();
      if (!version || cancelled) return;
      if (consumeVersionChange(version)) {
        setWhatsNew(entryFor(version));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── 2. الفحص عن تحديث ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const found = await checkForUpdate();
      if (!cancelled && found) setUpdate(found);
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const handleInstall = useCallback(async () => {
    if (!update) return;
    setInstalling(true);
    setError(null);
    try {
      await installUpdate(update, setProgress);
      // لا يُنفَّذ ما بعده عادةً — التطبيق يُعاد تشغيله
    } catch (e) {
      setInstalling(false);
      setProgress(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [update]);

  const handleSkip = useCallback(() => {
    if (update) skipVersion(update.version);
    setUpdate(null);
  }, [update]);

  // ═══ نافذة «ما الجديد» ═══
  if (whatsNew) {
    return (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        onClick={() => setWhatsNew(null)}
      >
        <div
          className="w-full max-w-lg bg-surface rounded-2xl border border-border shadow-2xl max-h-[85vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-6 pt-6 pb-4 border-b border-border">
            <div className="flex items-center gap-2 text-xs text-muted mb-1">
              <span className="px-2 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/30">
                الإصدار {whatsNew.version}
              </span>
              <span>{whatsNew.date}</span>
            </div>
            <h2 className="text-lg font-bold">ما الجديد</h2>
            {whatsNew.highlight && (
              <p className="text-sm text-muted mt-2 leading-relaxed">{whatsNew.highlight}</p>
            )}
          </div>

          <ul className="px-6 py-4 space-y-3 overflow-y-auto">
            {whatsNew.changes.map((c, i) => (
              <li key={i} className="flex items-start gap-3 text-sm leading-relaxed">
                <span
                  className={`shrink-0 mt-0.5 px-2 py-0.5 rounded-md border text-[11px] ${KIND_CLASS[c.kind]}`}
                >
                  {KIND_LABEL[c.kind]}
                </span>
                <span>{c.text}</span>
              </li>
            ))}
          </ul>

          <div className="px-6 py-4 border-t border-border">
            <button
              onClick={() => setWhatsNew(null)}
              className="w-full py-2.5 rounded-xl bg-primary hover:bg-primary-hover font-medium transition-colors"
            >
              ابدأ
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ═══ شريط «يتوفّر تحديث» ═══
  if (!update) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 w-[min(92vw,26rem)] bg-surface border border-border rounded-2xl shadow-2xl overflow-hidden">
      <div className="px-5 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-sm">يتوفّر إصدار جديد</h3>
            <p className="text-xs text-muted mt-1">
              {update.currentVersion} ← <span className="text-success">{update.version}</span>
            </p>
          </div>
          {!installing && (
            <button
              onClick={() => setUpdate(null)}
              className="text-muted hover:text-foreground text-lg leading-none px-1"
              aria-label="إغلاق"
            >
              ×
            </button>
          )}
        </div>

        {update.notes && !installing && (
          <p className="text-xs text-muted mt-3 max-h-24 overflow-y-auto whitespace-pre-line leading-relaxed">
            {update.notes}
          </p>
        )}

        {error && <p className="text-xs text-danger mt-3">تعذّر التحديث: {error}</p>}

        {installing && (
          <div className="mt-3">
            <div className="flex justify-between text-xs text-muted mb-1.5">
              <span>{progress?.percent === null ? "جارٍ التنزيل…" : "جارٍ التنزيل"}</span>
              {progress?.percent !== null && progress?.percent !== undefined && (
                <span>{progress.percent}%</span>
              )}
            </div>
            <div className="h-1.5 rounded-full bg-surface-hover overflow-hidden">
              <div
                className="h-full bg-primary transition-[width] duration-200"
                style={{ width: progress?.percent != null ? `${progress.percent}%` : "35%" }}
              />
            </div>
            <p className="text-[11px] text-muted mt-2">
              سيُعاد تشغيل التطبيق تلقائياً عند الانتهاء.
            </p>
          </div>
        )}
      </div>

      {!installing && (
        <div className="flex border-t border-border">
          <button
            onClick={handleSkip}
            className="flex-1 py-2.5 text-xs text-muted hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            تخطَّ هذا الإصدار
          </button>
          <button
            onClick={handleInstall}
            className="flex-1 py-2.5 text-xs font-medium bg-primary hover:bg-primary-hover transition-colors border-r border-border"
          >
            حدِّث الآن
          </button>
        </div>
      )}
    </div>
  );
}
