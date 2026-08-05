"use client";

/**
 * ═══════════════════════════════════════════════════════════════
 *  lib/updater.ts
 *  التحديث الهوائي — يقارن إصدار التطبيق بأحدث release على GitHub.
 *
 *  المسار:
 *    التطبيق ← latest.json في آخر release ← إن كان أحدث: تنزيل موقَّع
 *    ← تثبيت ← إعادة تشغيل ← نافذة «ما الجديد».
 *
 *  التوقيع إلزامي: يرفض Tauri أي حزمة تحديث لا يطابق توقيعها المفتاح
 *  العامّ المضمَّن في tauri.conf.json، فلا يمكن حقن تحديث مزوَّر.
 * ═══════════════════════════════════════════════════════════════
 */

import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** مفتاح تخزين آخر إصدار شاهده المستخدم — أساس نافذة «ما الجديد» */
const LAST_SEEN_KEY = "mufarrigh:last-seen-version";
/** إصدار اختار المستخدم تخطّيه — لا نُلحّ عليه به مجدداً */
const SKIPPED_KEY = "mufarrigh:skipped-version";

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  date?: string;
  /** ملاحظات الإصدار كما وردت في latest.json */
  notes?: string;
  /** المرجع الداخلي — يُمرَّر إلى installUpdate */
  handle: Update;
}

/** إصدار التطبيق الجاري (من tauri.conf.json وقت البناء) */
export async function currentVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await getVersion();
  } catch {
    return null;
  }
}

/**
 * الفحص عن تحديث. يُرجع null إن لم يوجد جديد، أو تعذّر الاتصال.
 * لا يرمي استثناءً أبداً: فشل الفحص يجب ألّا يعطّل بدء التطبيق.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isTauri()) return null;
  try {
    const update = await check({ timeout: 15_000 });
    if (!update) return null;

    // احترام اختيار المستخدم بتخطّي هذا الإصدار
    if (localStorage.getItem(SKIPPED_KEY) === update.version) return null;

    return {
      version: update.version,
      currentVersion: update.currentVersion,
      date: update.date,
      notes: update.body,
      handle: update,
    };
  } catch (e) {
    console.warn("تعذّر الفحص عن تحديث:", e);
    return null;
  }
}

export interface DownloadProgress {
  /** بايتات نُزّلت حتى الآن */
  downloaded: number;
  /** الحجم الكلي إن أعلنه الخادم */
  total: number | null;
  /** نسبة مئوية، أو null إن كان الحجم مجهولاً */
  percent: number | null;
}

/**
 * تنزيل التحديث وتثبيته ثم إعادة تشغيل التطبيق.
 * لا يعود هذا الاستدعاء عند النجاح — العملية تُستبدل بالنسخة الجديدة.
 */
export async function installUpdate(
  update: AvailableUpdate,
  onProgress?: (p: DownloadProgress) => void
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;

  await update.handle.downloadAndInstall((event: DownloadEvent) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        downloaded = 0;
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        break;
      case "Finished":
        downloaded = total ?? downloaded;
        break;
    }
    onProgress?.({
      downloaded,
      total,
      percent: total ? Math.min(100, Math.round((downloaded / total) * 100)) : null,
    });
  });

  await relaunch();
}

/** تخطّي إصدار بعينه فلا يُعرَض مجدداً */
export function skipVersion(version: string): void {
  try {
    localStorage.setItem(SKIPPED_KEY, version);
  } catch {
    /* التخزين ممتلئ أو محجوب — التخطّي ليس حرجاً */
  }
}

/**
 * هل تغيّر الإصدار منذ آخر تشغيل؟ يُستخدم لإظهار «ما الجديد».
 *
 * يُرجع false عند أول تشغيل على الإطلاق: المستخدم الذي ثبّت التطبيق
 * لتوّه لا يحتاج نافذة تخبره بما «جدّ» — لم يكن عنده شيء قبله.
 */
export function consumeVersionChange(version: string): boolean {
  try {
    const lastSeen = localStorage.getItem(LAST_SEEN_KEY);
    localStorage.setItem(LAST_SEEN_KEY, version);
    return lastSeen !== null && lastSeen !== version;
  } catch {
    return false;
  }
}
