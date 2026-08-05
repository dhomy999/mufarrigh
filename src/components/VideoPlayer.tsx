"use client";

/**
 * ═══════════════════════════════════════════════════════════════
 *  VideoPlayer.tsx
 *  مشغل الفيديو مع:
 *    - شريط زمني تفاعلي يعرض الفترات المحذوفة بصرياً
 *    - تحكم كامل (تشغيل/إيقاف/تقديم/صوت)
 *    - تكامل مع useSmartVideoPlayer للقفز الذكي
 * ═══════════════════════════════════════════════════════════════
 */

import { useRef, useCallback, useState, useEffect } from "react";
import { useSmartVideoPlayer } from "@/hooks/useSmartVideoPlayer";
import type { ExcludedRange } from "@/lib/editor-utils";
import { formatTimecode } from "@/lib/editor-utils";

interface VideoPlayerProps {
  /** رابط الفيديو (عبر convertFileSrc) */
  videoSrc: string;
  /** الفترات المحذوفة */
  excludedRanges: ExcludedRange[];
  /** عند تغيير الوقت (لمزامنة المحرر) */
  onTimeUpdate?: (time: number) => void;
  /** عند القفز فوق فترة محذوفة */
  onJump?: (from: number, to: number) => void;
}

export default function VideoPlayer({
  videoSrc,
  excludedRanges,
  onTimeUpdate,
  onJump,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [jumpFlash, setJumpFlash] = useState<{ from: number; to: number } | null>(null);

  const handleJump = useCallback(
    (from: number, to: number) => {
      onJump?.(from, to);
      // وميض بصري عند القفز
      setJumpFlash({ from, to });
      setTimeout(() => setJumpFlash(null), 400);
    },
    [onJump]
  );

  const player = useSmartVideoPlayer(videoRef, {
    excludedRanges,
    onTimeUpdate,
    onJump: handleJump,
  });

  // ─── سرعة التشغيل + الرجوع التلقائي عند الإيقاف (plan.md §2.5) ───
  const [playbackRate, setPlaybackRate] = useState(1);
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  const handleTogglePlay = useCallback(() => {
    const v = videoRef.current;
    if (player.isPlaying && v) {
      // رجوع تلقائي ثانيتين عند الإيقاف اليدوي (أعلى عائد/أقل جهد)
      v.currentTime = Math.max(0, v.currentTime - 2);
    }
    player.togglePlay();
  }, [player]);

  // ─── الشريط الزمني ───────────────────────────────────────────

  const handleTimelineClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      // في RTL، النقر يكون من اليمين
      const clickX = rect.right - e.clientX;
      const ratio = clickX / rect.width;
      const targetTime = ratio * player.duration;
      player.seek(targetTime);
    },
    [player]
  );

  const progressPercent = player.duration > 0
    ? (player.currentTime / player.duration) * 100
    : 0;

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* منطقة الفيديو */}
      <div className="relative flex-1 flex items-center justify-center bg-black overflow-hidden">
        <video
          ref={videoRef}
          src={videoSrc}
          crossOrigin="anonymous"
          className="max-w-full max-h-full"
          onClick={handleTogglePlay}
          playsInline
        />

        {/* وميض القفز */}
        {jumpFlash && (
          <div className="absolute inset-0 bg-primary/10 animate-pulse pointer-events-none flex items-center justify-center">
            <div className="bg-background/80 backdrop-blur-sm px-4 py-2 rounded-lg text-sm text-foreground border border-primary/30">
              ⏭️ قفز من {formatTimecode(jumpFlash.from)} إلى {formatTimecode(jumpFlash.to)}
            </div>
          </div>
        )}

        {/* زر التشغيل المركزي */}
        {!player.isPlaying && (
          <button
            onClick={handleTogglePlay}
            className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition-colors group"
          >
            <div className="w-16 h-16 rounded-full bg-primary/90 group-hover:bg-primary flex items-center justify-center transition-all group-hover:scale-110">
              <svg className="w-7 h-7 text-white mr-[-2px]" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </button>
        )}
      </div>

      {/* الشريط الزمني التفاعلي */}
      <div className="px-4 pt-3 pb-1 shrink-0">
        <div
          onClick={handleTimelineClick}
          className="relative h-8 bg-background rounded-lg cursor-pointer group border border-border"
        >
          {/* الفترات المحذوفة (مناطق حمراء) */}
          {player.duration > 0 &&
            excludedRanges.map((range, i) => {
              const leftPercent = (range.start / player.duration) * 100;
              const widthPercent = ((range.end - range.start) / player.duration) * 100;
              return (
                <div
                  key={i}
                  className="absolute top-0 bottom-0 bg-danger/40 border-l border-danger/60 rounded-sm"
                  style={{
                    right: `${leftPercent}%`,
                    width: `${widthPercent}%`,
                  }}
                  title={`محذوف: ${formatTimecode(range.start)} - ${formatTimecode(range.end)}`}
                />
              );
            })}

          {/* شريط التقدم */}
          <div
            className="absolute top-0 bottom-0 right-0 bg-primary/30 rounded-r-lg transition-all"
            style={{ width: `${progressPercent}%` }}
          />

          {/* مؤشر الوقت (الرأس) */}
          <div
            className="absolute top-[-2px] bottom-[-2px] w-1 bg-primary rounded-full shadow-lg shadow-primary/50 z-10"
            style={{ right: `calc(${progressPercent}% - 2px)` }}
          >
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-primary group-hover:scale-125 transition-transform" />
          </div>
        </div>
      </div>

      {/* أزرار التحكم */}
      <div className="flex items-center justify-between px-4 py-3 shrink-0">
        {/* الوقت */}
        <div className="flex items-center gap-2 text-xs font-mono text-muted" dir="ltr">
          <span className="text-foreground">{formatTimecode(player.currentTime)}</span>
          <span>/</span>
          <span>{formatTimecode(player.duration)}</span>
          <select
            value={playbackRate}
            onChange={(e) => setPlaybackRate(Number(e.target.value))}
            className="ml-1 px-1.5 py-0.5 bg-background border border-border rounded text-[11px] text-foreground focus:outline-none"
            title="سرعة التشغيل"
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
              <option key={r} value={r}>{r}×</option>
            ))}
          </select>
        </div>

        {/* أزرار التشغيل */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => player.skipBackward(10)}
            className="p-2 rounded-lg text-muted hover:text-foreground hover:bg-surface-hover transition-colors"
            title="رجوع 10 ثوانٍ"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6h-2c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
              <text x="12" y="16" textAnchor="middle" fontSize="7" fill="currentColor" fontWeight="bold">10</text>
            </svg>
          </button>

          <button
            onClick={handleTogglePlay}
            className="w-10 h-10 rounded-full bg-primary hover:bg-primary-hover text-white flex items-center justify-center transition-all hover:scale-105"
          >
            {player.isPlaying ? (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
              </svg>
            ) : (
              <svg className="w-5 h-5 mr-[-1px]" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <button
            onClick={() => player.skipForward(10)}
            className="p-2 rounded-lg text-muted hover:text-foreground hover:bg-surface-hover transition-colors"
            title="تقديم 10 ثوانٍ"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12.01 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z" />
              <text x="12" y="16" textAnchor="middle" fontSize="7" fill="currentColor" fontWeight="bold">10</text>
            </svg>
          </button>
        </div>

        {/* الصوت */}
        <div className="flex items-center gap-2">
          <button
            onClick={player.toggleMute}
            className="p-2 rounded-lg text-muted hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            {player.isMuted || player.volume === 0 ? (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              </svg>
            )}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={player.isMuted ? 0 : player.volume}
            onChange={(e) => player.handleVolumeChange(Number(e.target.value))}
            className="w-20 accent-primary"
            dir="ltr"
          />
        </div>
      </div>
    </div>
  );
}
