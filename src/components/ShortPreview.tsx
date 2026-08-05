"use client";

/**
 * ═══════════════════════════════════════════════════════════════
 *  ShortPreview.tsx
 *  معاينة المقطع قبل الاستخراج (plan.md §4.4)
 *
 *  يُشغّل الفيديو من وقت البدء وحتى النهاية بزرّ تشغيل/إيقاف
 *  ومؤشّر تقدّم. يعرض النصّ الفعلي للمقطع في شريط علوي.
 * ═══════════════════════════════════════════════════════════════
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { formatTime } from "@/lib/tauri-api";

interface ShortPreviewProps {
  /** مسار الفيديو الأصلي (file:// أو convertFileSrc) */
  videoUrl: string;
  /** بداية المقطع بالثواني */
  start: number;
  /** نهاية المقطع بالثواني */
  end: number;
  /** عنوان المقطع */
  title: string;
  /** إغلاق */
  onClose: () => void;
}

export default function ShortPreview({
  videoUrl,
  start,
  end,
  title,
  onClose,
}: ShortPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(start);
  const [resolvedSrc, setResolvedSrc] = useState<string>("");

  // تحويل المسار الخام إلى رابط قابل للتشغيل (Tauri asset protocol)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        const src = convertFileSrc(videoUrl);
        if (!cancelled) setResolvedSrc(src);
      } catch {
        if (!cancelled) setResolvedSrc(`file://${videoUrl}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoUrl]);

  // القفز إلى بداية المقطع عند الفتح
  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.currentTime = start;
      setCurrentTime(start);
    }
  }, [start, resolvedSrc]);

  const handlePlayPause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    // إن انتهى المقطع، ارجع للبداية قبل التشغيل
    if (v.currentTime >= end - 0.05) v.currentTime = start;
    if (v.paused) {
      v.play();
      setIsPlaying(true);
    } else {
      v.pause();
      setIsPlaying(false);
    }
  }, [start, end]);

  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    // الإيقاف عند نهاية المقطع
    if (v.currentTime >= end) {
      v.pause();
      setIsPlaying(false);
      v.currentTime = end;
    }
  }, [end]);

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = videoRef.current;
      if (!v) return;
      const t = Number(e.target.value);
      v.currentTime = t;
      setCurrentTime(t);
    },
    []
  );

  const handleRestart = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = start;
    setCurrentTime(start);
    v.play();
    setIsPlaying(true);
  }, [start]);

  const rangeDuration = end - start;
  const rangeProgress = Math.max(0, Math.min(1, (currentTime - start) / rangeDuration));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-2xl border border-border shadow-2xl w-full max-w-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <h3 className="text-sm font-bold text-foreground">معاينة المقطع</h3>
            <p className="text-[11px] text-muted">
              {formatTime(start)} → {formatTime(end)} ({rangeDuration.toFixed(0)}s)
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            ✕
          </button>
        </header>

        <div className="bg-black relative aspect-video">
          <video
            ref={videoRef}
            src={resolvedSrc}
            className="w-full h-full"
            onTimeUpdate={handleTimeUpdate}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            playsInline
          />
          {/* زرّ تشغيل كبير في المنتصف عند الإيقاف */}
          {!isPlaying && (
            <button
              onClick={handlePlayPause}
              className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition-colors group"
              aria-label="تشغيل"
            >
              <div className="w-16 h-16 rounded-full bg-primary/90 group-hover:bg-primary flex items-center justify-center transition-all group-hover:scale-110 shadow-lg shadow-primary/40">
                <svg className="w-7 h-7 text-white mr-[-2px]" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </button>
          )}
        </div>

        <div className="px-4 py-3 space-y-2">
          {/* شريط التقدّم ضمن نطاق المقطع فقط */}
          <input
            type="range"
            min={start}
            max={end}
            step={0.05}
            value={currentTime}
            onChange={handleSeek}
            className="w-full accent-primary"
            dir="ltr"
          />

          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted font-mono tabular-nums" dir="ltr">
              {formatTime(currentTime)} / {formatTime(end)}
            </span>
            <span className="text-xs text-foreground truncate max-w-[50%]" dir="rtl">
              {title}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={handleRestart}
                title="إعادة من البداية"
                className="p-1.5 rounded text-muted hover:text-foreground hover:bg-surface-hover"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
              </button>
              <button
                onClick={handlePlayPause}
                className="px-3 py-1 rounded-md bg-primary text-white text-xs font-bold hover:bg-primary-hover transition-colors"
              >
                {isPlaying ? "إيقاف" : "تشغيل"}
              </button>
            </div>
          </div>

          <p className="text-[10px] text-muted/70 text-center pt-1">
            معاينة ضمن الفيديو الأصلي — القالب/الترجمة المحروقة تُطبَّق بعد الاستخراج
            ({Math.round(rangeProgress * 100)}% من المقطع)
          </p>
        </div>
      </div>
    </div>
  );
}