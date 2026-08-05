/**
 * ═══════════════════════════════════════════════════════════════
 *  useSmartVideoPlayer.ts
 *  Hook لإدارة تشغيل الفيديو مع:
 *    1. قفز تلقائي فوق الفترات المحذوفة (Smart Seek)
 *    2. تأثير قطع سلس (Crossfade) لمنع فرقعة الصوت
 *    3. مزامنة الوقت مع المحرر النصي
 * ═══════════════════════════════════════════════════════════════
 */

import { useRef, useState, useCallback, useEffect } from "react";
import type { ExcludedRange } from "@/lib/editor-utils";
import { findExcludedRange } from "@/lib/editor-utils";

interface SmartVideoPlayerOptions {
  /** الفترات المحذوفة (مرتبة ومدمجة) */
  excludedRanges: ExcludedRange[];
  /** عند تغيير الكلمة الحالية (لمزامنة المحرر) */
  onTimeUpdate?: (time: number) => void;
  /** عند حدوث قفزة (لإظهار مؤشر بصري) */
  onJump?: (from: number, to: number) => void;
}

export function useSmartVideoPlayer(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  options: SmartVideoPlayerOptions
) {
  const { excludedRanges, onTimeUpdate, onJump } = options;

  // ─── State ──────────────────────────────────────────────────
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);

  // ─── Refs ───────────────────────────────────────────────────
  // نستخدم refs لضمان وصول أحدث البيانات في حلقة requestAnimationFrame
  const excludedRef = useRef(excludedRanges);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const onJumpRef = useRef(onJump);
  const rafRef = useRef<number | null>(null);
  const lastJumpTimeRef = useRef(0); // لمنع القفز المتكرر

  // Web Audio API للـ crossfade
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const isJumpingRef = useRef(false);

  // مزامنة الـ refs
  excludedRef.current = excludedRanges;
  onTimeUpdateRef.current = onTimeUpdate;
  onJumpRef.current = onJump;

  // ─── تهيئة Web Audio (Lazy — عند أول تشغيل) ────────────────
  const ensureAudioContext = useCallback(() => {
    const video = videoRef.current;
    if (!video || audioCtxRef.current) return;

    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new AudioCtx();
      const source = ctx.createMediaElementSource(video);
      const gain = ctx.createGain();

      gain.gain.value = 1.0;
      source.connect(gain);
      gain.connect(ctx.destination);

      audioCtxRef.current = ctx;
      gainNodeRef.current = gain;
      sourceNodeRef.current = source;

      console.log("✅ AudioContext للـ crossfade جاهز");
    } catch (e) {
      console.warn("تعذّر تهيئة AudioContext — سيتم القفز بدون crossfade:", e);
    }
  }, [videoRef]);

  // ─── القفز الذكي مع Crossfade ───────────────────────────────
  /**
   * ينفّذ قفزة زمنية مع تأثير قطع سلس:
   * 1. خفض الصوت تدريجياً (25ms fade-out)
   * 2. القفز إلى الوقت الجديد
   * 3. رفع الصوت تدريجياً (25ms fade-in)
   *
   * هذا يمنع "الفرقعة" (audio pop/click) الناتجة عن الانقطاع المفاجئ.
   */
  const crossfadeSeek = useCallback(
    (targetTime: number) => {
      const video = videoRef.current;
      if (!video) return;

      const gain = gainNodeRef.current;
      const ctx = audioCtxRef.current;

      // إذا لم يتوفر AudioContext، اقفز مباشرة
      if (!gain || !ctx) {
        video.currentTime = targetTime;
        return;
      }

      const FADE_MS = 25; // مدة الخفت/الظهور بالمللي ثانية
      const now = ctx.currentTime;
      const currentGain = gain.gain.value;

      // إلغاء أي منحنيات مجدولة سابقة
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(currentGain, now);

      // ═══ Phase 1: Fade-out (خفض الصوت) ═══
      gain.gain.linearRampToValueAtTime(0.0001, now + FADE_MS / 1000);

      isJumpingRef.current = true;

      // ═══ Phase 2: Seek (القفز الفعلي) ═══
      // ننتظر انتهاء fade-out ثم نقفز
      setTimeout(() => {
        if (!videoRef.current) return;
        videoRef.current.currentTime = targetTime;

        // ═══ Phase 3: Fade-in (إعادة الصوت) ═══
        const seekNow = ctx.currentTime;
        gain.gain.setValueAtTime(0.0001, seekNow);
        gain.gain.linearRampToValueAtTime(
          isMuted ? 0 : volume,
          seekNow + FADE_MS / 1000
        );

        isJumpingRef.current = false;
      }, FADE_MS + 5); // +5ms هامش أمان
    },
    [videoRef, volume, isMuted]
  );

  // ─── حلقة المراقبة (requestAnimationFrame) ──────────────────
  /**
   * تُفحص وقت التشغيل 60 مرة/ثانية وتقفز فوق أي فترة محذوفة.
   * أدق بكثير من حدث timeupdate (الذي يعمل 4 مرات/ثانية فقط).
   */
  const monitorLoop = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.paused || video.ended) return;

    // تخطّي المراقبة أثناء القفز النشط
    if (isJumpingRef.current) {
      rafRef.current = requestAnimationFrame(monitorLoop);
      return;
    }

    const time = video.currentTime;

    // إعلام المحرر بالوقت الحالي
    setCurrentTime(time);
    onTimeUpdateRef.current?.(time);

    // فحص الفترات المحذوفة
    const excluded = findExcludedRange(time, excludedRef.current);

    if (excluded && time - lastJumpTimeRef.current > 0.1) {
      lastJumpTimeRef.current = time;

      // إطلاق callback القفزة
      onJumpRef.current?.(time, excluded.end);

      // القفز مع crossfade
      crossfadeSeek(excluded.end);
    }

    rafRef.current = requestAnimationFrame(monitorLoop);
  }, [videoRef, crossfadeSeek]);

  // ─── تحكم التشغيل ───────────────────────────────────────────

  const play = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    // تهيئة AudioContext عند أول تشغيل (سياسة المتصفح)
    ensureAudioContext();

    // استئناف AudioContext إذا كان معلقاً
    audioCtxRef.current?.resume();

    video.play();
    setIsPlaying(true);
    rafRef.current = requestAnimationFrame(monitorLoop);
  }, [videoRef, ensureAudioContext, monitorLoop]);

  const pause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    video.pause();
    setIsPlaying(false);

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, [videoRef]);

  const togglePlay = useCallback(() => {
    isPlaying ? pause() : play();
  }, [isPlaying, play, pause]);

  const seek = useCallback(
    (time: number) => {
      const video = videoRef.current;
      if (!video) return;

      // إذا كان الوقت المطلوب داخل فترة محذوفة، اقفز لنهايتها
      const excluded = findExcludedRange(time, excludedRef.current);
      const targetTime = excluded ? excluded.end : time;

      crossfadeSeek(targetTime);
      setCurrentTime(targetTime);
      onTimeUpdateRef.current?.(targetTime);
    },
    [videoRef, crossfadeSeek]
  );

  const skipForward = useCallback(
    (seconds: number = 5) => {
      seek(currentTime + seconds);
    },
    [seek, currentTime]
  );

  const skipBackward = useCallback(
    (seconds: number = 5) => {
      seek(currentTime - seconds);
    },
    [seek, currentTime]
  );

  const handleVolumeChange = useCallback((vol: number) => {
    const video = videoRef.current;
    if (!video) return;

    video.volume = vol;
    video.muted = vol === 0;
    setVolume(vol);
    setIsMuted(vol === 0);

    if (gainNodeRef.current && audioCtxRef.current) {
      gainNodeRef.current.gain.setValueAtTime(
        vol,
        audioCtxRef.current.currentTime
      );
    }
  }, [videoRef]);

  const toggleMute = useCallback(() => {
    if (isMuted) {
      handleVolumeChange(volume || 1);
    } else {
      handleVolumeChange(0);
    }
  }, [isMuted, volume, handleVolumeChange]);

  // ─── ربط أحداث الفيديو ──────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onLoadedMetadata = () => {
      setDuration(video.duration);
    };

    const onEnded = () => {
      setIsPlaying(false);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("ended", onEnded);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);

    return () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);

      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [videoRef]);

  // تنظيف عند الإزالة
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      audioCtxRef.current?.close();
    };
  }, []);

  return {
    isPlaying,
    currentTime,
    duration,
    volume,
    isMuted,
    isSeeking,
    play,
    pause,
    togglePlay,
    seek,
    skipForward,
    skipBackward,
    handleVolumeChange,
    toggleMute,
  };
}
