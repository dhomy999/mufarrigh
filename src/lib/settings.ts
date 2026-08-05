"use client";

/**
 * ═══════════════════════════════════════════════════════════════
 *  settings.ts
 *  إعدادات مركزية عبر localStorage:
 *    1. تفريغ الصوت  (Groq / OpenAI / Speechmatics) — مفتاح + موديل
 *    2. سجل النماذج النصية — قائمة مرنة: اسم + مزوّد + موديل + مفتاح
 *    3. مهام النماذج النصية — لكل مهمة: النموذج المختار + برومت قابل للتعديل
 * ═══════════════════════════════════════════════════════════════
 */

import { useSyncExternalStore, useCallback } from "react";
import type { DictionaryEntry } from "@/core/document/types";
export type { DictionaryEntry };

export type TranscriptionProviderId = "groq" | "openai" | "speechmatics";
export type TextProviderId = "openai" | "anthropic" | "gemini";
/** كل المزوّدين (تُستخدم لمفاتيح التفريغ الصوتي) */
export type ProviderId =
  | "groq"
  | "openai"
  | "speechmatics"
  | "anthropic"
  | "gemini";

/** مسار المشروع: تفريغ نصّي أو تحرير فيديو (plan.md §3) */
export type ProjectMode = "text" | "video";

/** مفتاح API لكل مزوّد تفريغ صوتي */
export type ProviderKeys = Record<ProviderId, string>;

/** ── القسم الأول: نموذج نصّي مُسجَّل في السجل ─────────────────── */
export interface ModelConfig {
  /** معرّف داخلي ثابت */
  id: string;
  /** اسم مخصّص يظهر في اختيار المهام */
  name: string;
  /** المزوّد (يحدّد نقطة الاتصال) */
  provider: TextProviderId;
  /** معرّف الموديل الفعلي المُرسل للـ API */
  model: string;
  /** مفتاح API الخاص بهذا النموذج */
  apiKey: string;
}

/** ── القسم الثاني: مهام النماذج النصية ─────────────────────────── */
export type TextTaskId = "detectIssues" | "generateShorts";

export interface TaskConfig {
  /** معرّف النموذج المختار من السجل (قد يكون null إن لم يُختَر بعد) */
  modelId: string | null;
  /** البرومت (System Prompt) القابل للتعديل */
  prompt: string;
}

export interface AppSettings {
  /** مفاتيح API لمزوّدي تفريغ الصوت */
  keys: ProviderKeys;
  /** الموديل المختار لكل مزوّد تفريغ صوتي */
  transcriptionModels: Record<TranscriptionProviderId, string>;
  /** سجل النماذج النصية */
  models: ModelConfig[];
  /** إعداد كل مهمة نصية */
  tasks: Record<TextTaskId, TaskConfig>;
  /** مجلد المخرجات المختار ("" = مجلد الكاش الافتراضي) — plan.md §0.5 */
  outputDir: string;
  /** قاموس عام يُطبَّق على كل المشاريع (plan.md §3.1) */
  dictionary: DictionaryEntry[];
  /** هل المفاتيح مشفّرة على القرص؟ (plan.md §5.3) */
  keysEncrypted: boolean;
}

const STORAGE_KEY = "arabic-video-editor:settings-v2";
const UPDATE_EVENT = "app-settings-updated";

/** توليد معرّف فريد لنموذج جديد */
export function genModelId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fallthrough */
  }
  return `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── البرومتات الافتراضية (مطابقة لما في backend/Rust) ────────────

export const DEFAULT_SHORTS_PROMPT = `أنت محرر فيديو محترف متخصص في المحتوى العربي لمنصات Shorts و Reels و TikTok.

مهمتك: تحليل تفريغ فيديو واختيار أفضل اللحظات التي تصلح كمقاطع قصيرة جذابة.

## المعايير:
1. المدة: كل مقطع يجب ألا يتجاوز 60 ثانية ولا يقل عن 10 ثوانٍ
2. الجاذبية: اختر اللحظات الحماسية، المفيدة، أو التي تحتوي على معلومات قيّمة
3. الاكتمال: المقطع يجب أن يكون مكتمل المعنى (بداية ونهاية طبيعية)
4. العنوان: عنوان جذّاب بالعربية يصف المحتوى في 3-7 كلمات
5. السبب: اشرح باختصار لماذا هذا المقطع جيد

## قيود صارمة:
- أعد فقط JSON صالح بدون أي نص قبله أو بعده
- لا تستخدم markdown code blocks
- الأرقام يجب أن تطابق الطوابع الزمنية المُعطاة

## صيغة الإخراج المطلوبة بالضبط:
[
  {
    "title": "عنوان جذّاب بالعربية",
    "start": 12.5,
    "end": 58.3,
    "reason": "شرح موجز لجاذبية المقطع"
  }
]

اختر 3 إلى 5 مقاطع من أفضل اللحظات في الفيديو.`;

export const DEFAULT_ISSUES_PROMPT = `أنت مدقّق لغوي خبير متخصص في مراجعة نصوص التفريغ الآلي (ASR) للمحتوى العربي.

مهمتك: قراءة التفريغ واكتشاف المواضع التي من المرجّح أنها تحتوي على خطأ في التفريغ، أي:
- كلمة لا تناسب السياق أو تكسر المعنى
- جملة غير مترابطة أو غير منطقية
- تحريف صوتي واضح (كلمة قريبة صوتياً من الصحيحة لكنها خاطئة)
- أسماء أو مصطلحات مشوّهة

## قواعد مهمة:
- لا تُبلّغ عن أخطاء إملائية بسيطة أو علامات ترقيم — ركّز على ما يشير لخطأ تفريغ حقيقي
- إذا كان النص سليماً ومنطقياً، أعد مصفوفة فارغة []
- استخدم الطوابع الزمنية المُعطاة كما هي (start/end بالثواني)
- رتّب النتائج حسب الخطورة (الأعلى أولاً)

## قيود صارمة على الإخراج:
- أعد فقط JSON صالح بدون أي نص قبله أو بعده
- لا تستخدم markdown code blocks

## صيغة الإخراج المطلوبة بالضبط:
[
  {
    "text": "النص المشبوه كما ورد",
    "start": 12.5,
    "end": 14.2,
    "reason": "سبب اعتباره خطأً محتملاً",
    "suggestion": "التصحيح المقترح أو تركه فارغاً",
    "severity": "high"
  }
]

قيمة severity يجب أن تكون واحدة من: "high" أو "medium" أو "low".`;

// ─── النماذج الافتراضية (تُزرع أول مرة) ──────────────────────────

const SEED_MODELS: ModelConfig[] = [
  { id: "seed-openai", name: "GPT-4o", provider: "openai", model: "gpt-4o", apiKey: "" },
  { id: "seed-anthropic", name: "Claude Sonnet", provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "" },
  { id: "seed-gemini", name: "Gemini Flash", provider: "gemini", model: "gemini-2.5-flash", apiKey: "" },
];

export const DEFAULT_SETTINGS: AppSettings = {
  keys: { groq: "", openai: "", speechmatics: "", anthropic: "", gemini: "" },
  transcriptionModels: {
    groq: "whisper-large-v3",
    openai: "whisper-1",
    speechmatics: "enhanced",
  },
  models: SEED_MODELS,
  tasks: {
    detectIssues: { modelId: "seed-gemini", prompt: DEFAULT_ISSUES_PROMPT },
    generateShorts: { modelId: "seed-openai", prompt: DEFAULT_SHORTS_PROMPT },
  },
  outputDir: "",
  dictionary: [],
  keysEncrypted: false,
};

// ─── بيانات وصفية لعرض الإعدادات ─────────────────────────────────

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  hint: string;
  keyPlaceholder: string;
  /** اقتراحات موديلات (قابلة للكتابة اليدوية أيضاً) */
  models: string[];
  modelLabel: string;
}

export const TRANSCRIPTION_PROVIDERS: ProviderMeta[] = [
  {
    id: "groq",
    label: "Groq",
    hint: "console.groq.com",
    keyPlaceholder: "gsk_...",
    models: ["whisper-large-v3", "whisper-large-v3-turbo"],
    modelLabel: "الموديل",
  },
  {
    id: "openai",
    label: "OpenAI",
    hint: "platform.openai.com",
    keyPlaceholder: "sk-...",
    models: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
    modelLabel: "الموديل",
  },
  {
    id: "speechmatics",
    label: "Speechmatics",
    hint: "portal.speechmatics.com",
    keyPlaceholder: "مفتاح Speechmatics",
    models: ["enhanced", "standard"],
    modelLabel: "مستوى المعالجة",
  },
];

/** بيانات مزوّدي النماذج النصية — تُستخدم في سجل النماذج (اختيار المزوّد + اقتراح الموديلات) */
export interface TextProviderMeta {
  id: TextProviderId;
  label: string;
  hint: string;
  keyPlaceholder: string;
  models: string[];
}

export const TEXT_PROVIDERS: TextProviderMeta[] = [
  {
    id: "openai",
    label: "OpenAI",
    hint: "platform.openai.com",
    keyPlaceholder: "sk-...",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1"],
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    hint: "console.anthropic.com",
    keyPlaceholder: "sk-ant-...",
    models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
  },
  {
    id: "gemini",
    label: "Gemini (Google)",
    hint: "aistudio.google.com",
    keyPlaceholder: "AIza...",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  },
];

/** بيانات مهام نصية — العنوان + الوصف + البرومت الافتراضي (للاستعادة) */
export interface TextTaskMeta {
  id: TextTaskId;
  label: string;
  description: string;
  defaultPrompt: string;
  /** المسار الذي تخصّه هذه المهمة (plan.md §3.2 — تقسيم الإعدادات) */
  mode: ProjectMode;
}

export const TEXT_TASKS: TextTaskMeta[] = [
  {
    id: "detectIssues",
    label: "كشف الأخطاء",
    description: "مراجعة التفريغ واكتشاف المواضع غير المنطقية",
    defaultPrompt: DEFAULT_ISSUES_PROMPT,
    mode: "text",
  },
  {
    id: "generateShorts",
    label: "توليد Shorts",
    description: "اقتراح أفضل اللحظات كمقاطع قصيرة",
    defaultPrompt: DEFAULT_SHORTS_PROMPT,
    mode: "video",
  },
];

/** استرجاع النموذج المختار لمهمة (أو undefined) */
export function resolveTaskModel(
  settings: AppSettings,
  taskId: TextTaskId
): ModelConfig | undefined {
  const id = settings.tasks[taskId]?.modelId;
  if (!id) return undefined;
  return settings.models.find((m) => m.id === id);
}

// ─── تحميل/حفظ ───────────────────────────────────────────────────

type RawSettings = Partial<AppSettings> & {
  /** حقل قديم (v2) — يُهاجَر إلى السجل عند وجوده */
  textModels?: Partial<Record<TextProviderId, string>>;
};

function normalizeModel(m: Partial<ModelConfig>, i: number): ModelConfig {
  const provider: TextProviderId =
    m.provider === "anthropic" || m.provider === "gemini" ? m.provider : "openai";
  return {
    id: typeof m.id === "string" && m.id ? m.id : `model-${i}-${Math.random().toString(36).slice(2, 8)}`,
    name: typeof m.name === "string" ? m.name : "",
    provider,
    model: typeof m.model === "string" ? m.model : "",
    apiKey: typeof m.apiKey === "string" ? m.apiKey : "",
  };
}

/** يزرع السجل الافتراضي وينقل المفاتيح القديمة (keys/textModels) إن وُجدت */
function seedModelsFrom(raw: RawSettings): ModelConfig[] {
  const keys: Partial<ProviderKeys> = raw.keys ?? {};
  const textModels: Partial<Record<TextProviderId, string>> = raw.textModels ?? {};
  return SEED_MODELS.map((seed) => ({
    ...seed,
    model: textModels[seed.provider] ?? seed.model,
    apiKey: keys[seed.provider] ?? "",
  }));
}

function mergeSettings(raw: RawSettings | null): AppSettings {
  if (!raw) return DEFAULT_SETTINGS;

  const models =
    Array.isArray(raw.models) && raw.models.length > 0
      ? raw.models.map(normalizeModel)
      : seedModelsFrom(raw);

  const modelIds = new Set(models.map((m) => m.id));
  const fallbackId = models[0]?.id ?? null;

  const mergeTask = (id: TextTaskId): TaskConfig => {
    const stored = raw.tasks?.[id];
    const base = DEFAULT_SETTINGS.tasks[id];
    let modelId = stored?.modelId ?? base.modelId;
    // تأكّد أنّ النموذج المشار إليه ما زال موجوداً
    if (!modelId || !modelIds.has(modelId)) modelId = fallbackId;
    return {
      modelId,
      prompt: typeof stored?.prompt === "string" ? stored.prompt : base.prompt,
    };
  };

  return {
    keys: { ...DEFAULT_SETTINGS.keys, ...(raw.keys ?? {}) },
    transcriptionModels: {
      ...DEFAULT_SETTINGS.transcriptionModels,
      ...(raw.transcriptionModels ?? {}),
    },
    models,
    tasks: {
      detectIssues: mergeTask("detectIssues"),
      generateShorts: mergeTask("generateShorts"),
    },
    outputDir:
      typeof raw.outputDir === "string" ? raw.outputDir : "",
    dictionary: Array.isArray(raw.dictionary)
      ? raw.dictionary.filter((d: unknown): d is DictionaryEntry =>
          typeof d === "object" && d !== null &&
          typeof (d as DictionaryEntry).match === "string" &&
          typeof (d as DictionaryEntry).replacement === "string" &&
          ((d as DictionaryEntry).kind === "text" || (d as DictionaryEntry).kind === "regex")
        )
      : [],
    keysEncrypted:
      typeof raw.keysEncrypted === "boolean" ? raw.keysEncrypted : false,
  };
}

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return mergeSettings(raw ? (JSON.parse(raw) as RawSettings) : null);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event(UPDATE_EVENT));
}

// ─── مخزن خارجي لـ useSyncExternalStore (آمن للـ SSR/hydration) ──

let cachedRaw: string | null = null;
let cachedSettings: AppSettings = DEFAULT_SETTINGS;

function subscribe(callback: () => void): () => void {
  window.addEventListener(UPDATE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(UPDATE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function getSnapshot(): AppSettings {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === cachedRaw) return cachedSettings;
  cachedRaw = raw;
  try {
    cachedSettings = mergeSettings(raw ? (JSON.parse(raw) as RawSettings) : null);
  } catch {
    cachedSettings = DEFAULT_SETTINGS;
  }
  return cachedSettings;
}

function getServerSnapshot(): AppSettings {
  return DEFAULT_SETTINGS;
}

/** Hook للوصول للإعدادات مع مزامنة تلقائية بين كل المكوّنات المفتوحة. */
export function useSettings(): {
  settings: AppSettings;
  update: (settings: AppSettings) => void;
} {
  const settings = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const update = useCallback((next: AppSettings) => saveSettings(next), []);
  return { settings, update };
}
