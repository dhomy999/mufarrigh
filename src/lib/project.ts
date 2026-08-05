/**
 * ═══════════════════════════════════════════════════════════════
 *  project.ts
 *  حفظ المشاريع واستعادتها — الجسر مع أوامر Tauri
 *
 *  كل مشروع ملف JSON واحد { meta, data } في مجلد بيانات التطبيق.
 *  المعرّف ثابت مشتق من مسار الفيديو → إعادة الحفظ تُحدِّث نفس المشروع.
 * ═══════════════════════════════════════════════════════════════
 */

import {
  normalizeError,
  type VideoInfo,
  type SilenceDetectionResult,
  type TranscriptionResult,
} from "./tauri-api";
import type { WordState } from "./editor-utils";
import {
  migrateProjectV1ToV2,
  type TranscriptDocument,
} from "@/core/document";
import type { ProjectMode } from "./settings";

const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ───────────────────────────────────────────────────────────────
//  الأنواع
// ───────────────────────────────────────────────────────────────

/** بيانات وصفية لمشروع — مطابقة لـ ProjectMeta في Rust */
export interface ProjectMeta {
  id: string;
  name: string;
  video_path: string;
  video_exists: boolean;
  updated_at: string;
  duration: number;
  word_count: number;
  deleted_count: number;
}

/**
 * حمولة مشروع v1 (النموذج القديم) — تُقرأ من القرص للترحيل فقط.
 * راجع plan.md §2.4.
 */
export interface ProjectDataV1 {
  version: 1;
  video: VideoInfo;
  audioPath: string | null;
  noiseDb: number;
  minDur: number;
  silence: SilenceDetectionResult | null;
  removedSegments: number[];
  transcription: TranscriptionResult | null;
  /** كلمات المحرر بحالتها (حذف + تعديلات) — null إن لم يدخل الاستوديو بعد */
  words: WordState[] | null;
}

/**
 * حمولة مشروع v2 — المستند الموحّد (تدفّق توكِنات) هو المخزن الأساسي.
 */
export interface ProjectDataV2 {
  version: 2;
  /** مسار المشروع: نصّي أو فيديو (plan.md §3) */
  mode: ProjectMode;
  video: VideoInfo;
  audioPath: string | null;
  noiseDb: number;
  minDur: number;
  silence: SilenceDetectionResult | null;
  removedSegments: number[];
  /** المستند الموحّد — النواة المشتركة بين مسارَي النصّ والفيديو */
  document: TranscriptDocument;
  /** النصّ الكامل (للعرض السريع دون إعادة بناء) */
  fullText: string;
  /** مدّة المصدر بالثواني */
  duration: number;
}

/** مظروف المشروع كما يُكتب الآن — v2 دائماً */
export interface ProjectEnvelope {
  schemaVersion: 2;
  meta: ProjectMeta;
  data: ProjectDataV2;
}

/** مظروف خام كما يُقرأ من القرص — قد يكون v1 أو v2 */
interface RawProjectEnvelope {
  schemaVersion?: number;
  meta: ProjectMeta;
  data: ProjectDataV1 | ProjectDataV2;
}

/**
 * تطبيع مظروف مقروء من القرص إلى v2 دائماً.
 * إن كان قديماً (v1) يُرحَّل بأمان عبر migrateProjectV1ToV2.
 */
export function normalizeEnvelope(raw: RawProjectEnvelope): ProjectEnvelope {
  const isV2 = raw.schemaVersion === 2 || raw.data?.version === 2;
  if (isV2) {
    return { schemaVersion: 2, meta: raw.meta, data: raw.data as ProjectDataV2 };
  }
  // v1 → ترحيل غير مدمّر إلى v2
  const migrated = migrateProjectV1ToV2(raw.data as ProjectDataV1);
  return { schemaVersion: 2, meta: raw.meta, data: migrated };
}

// ───────────────────────────────────────────────────────────────
//  المعرّف الثابت
// ───────────────────────────────────────────────────────────────

/**
 * معرّف ثابت مشتق من مسار الفيديو (djb2) — ASCII فقط ليقبله الخادم.
 * نفس الفيديو ⇒ نفس المعرّف ⇒ الحفظ يُحدِّث المشروع بدل تكراره.
 */
export function projectIdForVideo(videoPath: string): string {
  let h = 5381;
  for (let i = 0; i < videoPath.length; i++) {
    h = ((h << 5) + h + videoPath.charCodeAt(i)) >>> 0;
  }
  return `p${h.toString(16)}`;
}

// ───────────────────────────────────────────────────────────────
//  أوامر Tauri
// ───────────────────────────────────────────────────────────────

/** 💾 حفظ مشروع (إنشاء أو تحديث) */
export async function saveProject(envelope: ProjectEnvelope): Promise<void> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("save_project", {
      id: envelope.meta.id,
      projectJson: JSON.stringify(envelope),
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

/** 📋 قائمة المشاريع المحفوظة — الأحدث أولاً */
export async function listProjects(): Promise<ProjectMeta[]> {
  if (!isTauri()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<ProjectMeta[]>("list_projects");
  } catch (error) {
    throw normalizeError(error);
  }
}

/** 📂 تحميل مشروع كاملاً */
export async function loadProject(id: string): Promise<ProjectEnvelope> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const raw = await invoke<string>("load_project", { id });
    // الملف على القرص قد يكون v1 أو v2 — نُطبّع إلى v2 دائماً (مع ترحيل آمن)
    return normalizeEnvelope(JSON.parse(raw) as RawProjectEnvelope);
  } catch (error) {
    throw normalizeError(error);
  }
}

/** 🗑 حذف مشروع محفوظ */
export async function deleteProject(id: string): Promise<void> {
  if (!isTauri()) throw new Error("هذا التطبيق يعمل فقط داخل سطح المكتب (Tauri)");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("delete_project", { id });
  } catch (error) {
    throw normalizeError(error);
  }
}
