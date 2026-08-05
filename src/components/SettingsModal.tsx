"use client";

/**
 * ═══════════════════════════════════════════════════════════════
 *  SettingsModal.tsx
 *  نافذة الإعدادات — ثلاثة أقسام:
 *    1. تفريغ الصوت           (مفتاح + موديل لكل مزوّد)
 *    2. النماذج               (سجل مرن: اسم + مزوّد + موديل + مفتاح)
 *    3. مهام النماذج النصية   (اختيار النموذج + برومت قابل للتعديل)
 *  تُحفظ محلياً.
 * ═══════════════════════════════════════════════════════════════
 */

import { useState } from "react";
import DictionaryManager from "./DictionaryManager";
import {
  useSettings,
  TRANSCRIPTION_PROVIDERS,
  TEXT_PROVIDERS,
  TEXT_TASKS,
  genModelId,
  type AppSettings,
  type ProviderMeta,
  type ProviderId,
  type TranscriptionProviderId,
  type ModelConfig,
  type TextProviderId,
  type TextTaskId,
} from "@/lib/settings";
import {
  encryptKeys,
  decryptKeys,
  saveSecurePayload,
  loadSecurePayload,
  clearSecureStorage,
  hasWebCrypto,
} from "@/lib/secure-storage";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { settings, update } = useSettings();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState(false);
  const [showGlobalDict, setShowGlobalDict] = useState(false);
  // ─── أمان المفاتيح (plan.md §5.3) ───────────────────────────────
  const [cryptoPass, setCryptoPass] = useState("");
  const [cryptoPass2, setCryptoPass2] = useState("");
  const [cryptoBusy, setCryptoBusy] = useState(false);
  const [cryptoError, setCryptoError] = useState<string | null>(null);
  const [cryptoStatus, setCryptoStatus] = useState<string | null>(null);

  // مزامنة المسودّة عند فتح النافذة (تعديل الحالة أثناء الرسم — نمط React الموصى به)
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft(settings);
      setSaved(false);
    }
  }

  if (!open) return null;

  // ─── تفريغ الصوت ──────────────────────────────────────────────
  const setKey = (id: ProviderId, value: string) =>
    setDraft((d) => ({ ...d, keys: { ...d.keys, [id]: value } }));

  const setTranscriptionModel = (id: TranscriptionProviderId, value: string) =>
    setDraft((d) => ({
      ...d,
      transcriptionModels: { ...d.transcriptionModels, [id]: value },
    }));

  // ─── سجل النماذج ──────────────────────────────────────────────
  const addModel = () =>
    setDraft((d) => ({
      ...d,
      models: [
        ...d.models,
        { id: genModelId(), name: "", provider: "openai", model: "", apiKey: "" },
      ],
    }));

  const updateModel = (id: string, patch: Partial<ModelConfig>) =>
    setDraft((d) => ({
      ...d,
      models: d.models.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }));

  const removeModel = (id: string) =>
    setDraft((d) => ({
      ...d,
      models: d.models.filter((m) => m.id !== id),
      // لو كانت مهمة تشير لهذا النموذج، أفرِغ الاختيار
      tasks: {
        detectIssues: {
          ...d.tasks.detectIssues,
          modelId: d.tasks.detectIssues.modelId === id ? null : d.tasks.detectIssues.modelId,
        },
        generateShorts: {
          ...d.tasks.generateShorts,
          modelId: d.tasks.generateShorts.modelId === id ? null : d.tasks.generateShorts.modelId,
        },
      },
    }));

  // ─── مهام النماذج النصية ──────────────────────────────────────
  const setTaskModel = (task: TextTaskId, modelId: string | null) =>
    setDraft((d) => ({
      ...d,
      tasks: { ...d.tasks, [task]: { ...d.tasks[task], modelId } },
    }));

  const setTaskPrompt = (task: TextTaskId, prompt: string) =>
    setDraft((d) => ({
      ...d,
      tasks: { ...d.tasks, [task]: { ...d.tasks[task], prompt } },
    }));

  const toggleVisible = (uid: string) =>
    setVisible((v) => ({ ...v, [uid]: !v[uid] }));

  const handleSave = () => {
    update(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  // ─── تشفير/فك تشفير المفاتيح ───────────────────────────────────
  const handleEncryptKeys = async () => {
    setCryptoError(null);
    setCryptoStatus(null);
    if (cryptoPass.length < 4) {
      setCryptoError("كلمة المرور قصيرة (4 أحرف على الأقل)");
      return;
    }
    if (cryptoPass !== cryptoPass2) {
      setCryptoError("كلمتا المرور غير متطابقتين");
      return;
    }
    setCryptoBusy(true);
    try {
      const blob = await encryptKeys(draft.keys, cryptoPass);
      saveSecurePayload({ kind: "encrypted", blob });
      // امسح المفاتيح من المخزن العام
      const empty = { ...draft, keys: { ...draft.keys, groq: "", openai: "", speechmatics: "", anthropic: "", gemini: "" }, keysEncrypted: true };
      update(empty);
      setDraft(empty);
      setCryptoPass("");
      setCryptoPass2("");
      setCryptoStatus("تم التشفير — لن تُحفظ المفاتيح إلا بعد فك التشفير");
      setTimeout(() => setCryptoStatus(null), 4000);
    } catch (e) {
      setCryptoError(e instanceof Error ? e.message : String(e));
    } finally {
      setCryptoBusy(false);
    }
  };

  const handleDecryptKeys = async () => {
    setCryptoError(null);
    setCryptoStatus(null);
    const payload = loadSecurePayload();
    if (!payload || payload.kind !== "encrypted") {
      setCryptoError("لا توجد مفاتيح مشفّرة");
      return;
    }
    if (!cryptoPass) {
      setCryptoError("أدخل كلمة المرور");
      return;
    }
    setCryptoBusy(true);
    try {
      const keys = await decryptKeys(payload.blob, cryptoPass);
      const next = { ...draft, keys, keysEncrypted: false };
      update(next);
      setDraft(next);
      clearSecureStorage();
      setCryptoPass("");
      setCryptoStatus("تم فك التشفير");
      setTimeout(() => setCryptoStatus(null), 3000);
    } catch (e) {
      setCryptoError(e instanceof Error ? e.message : String(e));
    } finally {
      setCryptoBusy(false);
    }
  };

  const storedBlob = typeof window !== "undefined" ? loadSecurePayload() : null;
  const cryptoSupported = hasWebCrypto();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-surface rounded-2xl border border-border shadow-2xl max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* رأس */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-base font-bold text-foreground flex items-center gap-2">
            <svg className="w-5 h-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            الإعدادات
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* المحتوى */}
        {showGlobalDict && (
        <DictionaryManager
          title="القاموس العام"
          entries={draft.dictionary}
          onChange={(next) => setDraft((d) => ({ ...d, dictionary: next }))}
          onClose={() => setShowGlobalDict(false)}
        />
      )}

      <div className="px-5 py-4 space-y-6 overflow-y-auto">
          <p className="text-xs text-muted">
            تُحفظ المفاتيح محلياً على جهازك فقط ولا تُرسل إلا لمزوّد الخدمة المعني.
          </p>

          {/* ═══ قسم تفريغ الصوت ═══ */}
          <Section
            title="تفريغ الصوت"
            subtitle="نماذج تحويل الكلام إلى نص"
            icon={
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
              </svg>
            }
          >
            {TRANSCRIPTION_PROVIDERS.map((p) => (
              <ProviderCard
                key={`asr-${p.id}`}
                meta={p}
                uid={`asr-${p.id}`}
                apiKey={draft.keys[p.id]}
                model={draft.transcriptionModels[p.id as TranscriptionProviderId]}
                visible={!!visible[`asr-${p.id}`]}
                onKeyChange={(v) => setKey(p.id, v)}
                onModelChange={(v) => setTranscriptionModel(p.id as TranscriptionProviderId, v)}
                onToggleVisible={() => toggleVisible(`asr-${p.id}`)}
              />
            ))}
          </Section>

          {/* ═══ قسم القاموس (plan.md §3.1) ═══ */}
          <Section
            title="القاموس العام"
            subtitle="يُطبَّق على كل المشاريع — استبدال نصّي أو regex، ويُمرَّر لـ Speechmatics قبل التفريغ"
            icon={
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            }
          >
            <button
              onClick={() => setShowGlobalDict(true)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl bg-background border border-border hover:border-primary/40 hover:bg-surface-hover transition-colors"
            >
              <span className="text-sm text-foreground">
                إدارة القاموس العام
                <span className="text-[11px] text-muted mr-2">
                  ({draft.dictionary.length} مدخل)
                </span>
              </span>
              <svg className="w-4 h-4 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </Section>

          {/* ═══ قسم أمان المفاتيح (plan.md §5.3) ═══ */}
          <Section
            title="أمان المفاتيح"
            subtitle="تشفير مفاتيح API بكلمة مرور (AES-GCM + PBKDF2)"
            icon={
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            }
          >
            {!cryptoSupported ? (
              <p className="text-xs text-muted">Web Crypto غير متاح في هذه البيئة.</p>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted">الحالة:</span>
                  {storedBlob?.kind === "encrypted" || draft.keysEncrypted ? (
                    <span className="px-2 py-0.5 rounded-full bg-success/20 text-success font-bold">
                      🔒 مشفّرة
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full bg-muted/20 text-muted font-bold">
                      🔓 غير مشفّرة (نصّ صريح)
                    </span>
                  )}
                </div>

                <input
                  type="password"
                  value={cryptoPass}
                  onChange={(e) => setCryptoPass(e.target.value)}
                  placeholder="كلمة المرور"
                  dir="ltr"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary"
                />

                {(!draft.keysEncrypted && storedBlob?.kind !== "encrypted") ? (
                  <>
                    <input
                      type="password"
                      value={cryptoPass2}
                      onChange={(e) => setCryptoPass2(e.target.value)}
                      placeholder="تأكيد كلمة المرور"
                      dir="ltr"
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary"
                    />
                    <button
                      onClick={handleEncryptKeys}
                      disabled={cryptoBusy || !draft.keys.groq && !draft.keys.openai && !draft.keys.speechmatics && !draft.keys.anthropic && !draft.keys.gemini}
                      className="w-full px-3 py-2 rounded-lg bg-primary text-white text-xs font-bold hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {cryptoBusy ? "..." : "🔒 شفّر المفاتيح"}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={handleDecryptKeys}
                    disabled={cryptoBusy}
                    className="w-full px-3 py-2 rounded-lg bg-success text-white text-xs font-bold hover:bg-success-hover disabled:opacity-40 transition-colors"
                  >
                    {cryptoBusy ? "..." : "🔓 فك التشفير وحفظ النصّ الصريح"}
                  </button>
                )}

                {cryptoError && (
                  <div className="text-xs text-danger">{cryptoError}</div>
                )}
                {cryptoStatus && (
                  <div className="text-xs text-success">{cryptoStatus}</div>
                )}
                <p className="text-[10px] text-muted/70 pt-1">
                  عند التشفير تُمحى المفاتيح من التخزين العام وتُستبدل بنصّ مشفّر.
                  فك التشفير يتطلب كلمة المرور في كل جلسة.
                </p>
              </div>
            )}
          </Section>

          {/* ═══ قسم النماذج (السجل) ═══ */}
          <Section
            title="النماذج"
            subtitle="أضِف أي عدد من النماذج — اسم ومزوّد وموديل ومفتاح"
            icon={
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            }
          >
            {draft.models.length === 0 && (
              <p className="text-xs text-muted py-2">
                لا توجد نماذج بعد. أضِف نموذجاً لاستخدامه في المهام النصية.
              </p>
            )}
            {draft.models.map((m) => (
              <ModelCard
                key={m.id}
                model={m}
                visible={!!visible[`model-${m.id}`]}
                onChange={(patch) => updateModel(m.id, patch)}
                onRemove={() => removeModel(m.id)}
                onToggleVisible={() => toggleVisible(`model-${m.id}`)}
              />
            ))}
            <button
              onClick={addModel}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-border text-xs font-medium text-muted hover:text-foreground hover:border-primary hover:bg-surface-hover transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              إضافة نموذج
            </button>
          </Section>

          {/* ═══ قسم مهام النماذج (مجمَّعة حسب المسار — plan.md §3.2) ═══ */}
          <Section
            title="مهام النماذج"
            subtitle="مجمَّعة حسب المسار — اختر النموذج وعدّل البرومت"
            icon={
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
            }
          >
            {(["text", "video"] as const).map((grpMode) => {
              const tasks = TEXT_TASKS.filter((t) => t.mode === grpMode);
              if (tasks.length === 0) return null;
              return (
                <div key={grpMode} className="space-y-2.5">
                  <p className="text-[11px] font-bold text-muted/80 uppercase tracking-wider pt-1">
                    {grpMode === "text" ? "📝 مسار النصّ" : "🎬 مسار الفيديو"}
                  </p>
                  {tasks.map((t) => (
                    <TaskCard
                      key={t.id}
                      label={t.label}
                      description={t.description}
                      defaultPrompt={t.defaultPrompt}
                      models={draft.models}
                      modelId={draft.tasks[t.id].modelId}
                      prompt={draft.tasks[t.id].prompt}
                      onModelChange={(id) => setTaskModel(t.id, id)}
                      onPromptChange={(v) => setTaskPrompt(t.id, v)}
                    />
                  ))}
                </div>
              );
            })}
          </Section>
        </div>

        {/* تذييل */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
          {saved && (
            <span className="text-xs text-success mr-auto flex items-center gap-1">
              ✅ تم الحفظ
            </span>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            إغلاق
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 rounded-lg text-sm font-bold bg-primary text-white hover:bg-primary-hover transition-colors"
          >
            حفظ
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  مكوّنات مساعدة
// ═══════════════════════════════════════════════════════════════

function Section({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <span className="w-7 h-7 rounded-lg bg-primary/15 text-primary flex items-center justify-center">
          {icon}
        </span>
        <div>
          <h3 className="text-sm font-bold text-foreground">{title}</h3>
          <p className="text-[10px] text-muted">{subtitle}</p>
        </div>
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

/** بطاقة مزوّد تفريغ صوتي (مفتاح ثابت + موديل) */
function ProviderCard({
  meta,
  uid,
  apiKey,
  model,
  visible,
  onKeyChange,
  onModelChange,
  onToggleVisible,
}: {
  meta: ProviderMeta;
  uid: string;
  apiKey: string;
  model: string;
  visible: boolean;
  onKeyChange: (v: string) => void;
  onModelChange: (v: string) => void;
  onToggleVisible: () => void;
}) {
  const listId = `models-${uid}`;
  return (
    <div className="p-3 rounded-xl bg-background border border-border space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-foreground flex items-center gap-2">
          {meta.label}
          {apiKey ? (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-success/20 text-success">مضبوط</span>
          ) : (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-muted/20 text-muted">فارغ</span>
          )}
        </span>
        <span className="text-[10px] text-muted/70" dir="ltr">{meta.hint}</span>
      </div>

      {/* مفتاح API */}
      <div className="flex gap-2">
        <input
          type={visible ? "text" : "password"}
          value={apiKey}
          onChange={(e) => onKeyChange(e.target.value)}
          placeholder={meta.keyPlaceholder}
          dir="ltr"
          className="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-primary transition-colors"
        />
        <button
          onClick={onToggleVisible}
          className="px-3 py-2 text-xs text-muted hover:text-foreground bg-surface-hover rounded-lg transition-colors shrink-0"
        >
          {visible ? "إخفاء" : "إظهار"}
        </button>
      </div>

      {/* اختيار الموديل */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted shrink-0 w-24">{meta.modelLabel}</label>
        <input
          list={listId}
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
          dir="ltr"
          className="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-primary transition-colors"
        />
        <datalist id={listId}>
          {meta.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

/** بطاقة نموذج في السجل (اسم + مزوّد + موديل + مفتاح + حذف) */
function ModelCard({
  model,
  visible,
  onChange,
  onRemove,
  onToggleVisible,
}: {
  model: ModelConfig;
  visible: boolean;
  onChange: (patch: Partial<ModelConfig>) => void;
  onRemove: () => void;
  onToggleVisible: () => void;
}) {
  const providerMeta = TEXT_PROVIDERS.find((p) => p.id === model.provider);
  const listId = `model-models-${model.id}`;
  return (
    <div className="p-3 rounded-xl bg-background border border-border space-y-2.5">
      {/* الاسم + زر حذف */}
      <div className="flex items-center gap-2">
        <input
          value={model.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="اسم النموذج (مثال: Claude السريع)"
          className="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm font-medium text-foreground focus:outline-none focus:border-primary transition-colors"
        />
        {model.apiKey ? (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-success/20 text-success shrink-0">مضبوط</span>
        ) : (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-muted/20 text-muted shrink-0">فارغ</span>
        )}
        <button
          onClick={onRemove}
          title="حذف النموذج"
          className="p-1.5 rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors shrink-0"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>

      {/* المزوّد + الموديل */}
      <div className="flex items-center gap-2">
        <select
          value={model.provider}
          onChange={(e) => onChange({ provider: e.target.value as TextProviderId })}
          className="w-32 px-2 py-2 bg-surface border border-border rounded-lg text-xs text-foreground focus:outline-none focus:border-primary transition-colors shrink-0"
        >
          {TEXT_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <input
          list={listId}
          value={model.model}
          onChange={(e) => onChange({ model: e.target.value })}
          placeholder="معرّف الموديل"
          dir="ltr"
          className="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-primary transition-colors"
        />
        <datalist id={listId}>
          {(providerMeta?.models ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>

      {/* مفتاح API */}
      <div className="flex gap-2">
        <input
          type={visible ? "text" : "password"}
          value={model.apiKey}
          onChange={(e) => onChange({ apiKey: e.target.value })}
          placeholder={providerMeta?.keyPlaceholder ?? "مفتاح API"}
          dir="ltr"
          className="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-primary transition-colors"
        />
        <button
          onClick={onToggleVisible}
          className="px-3 py-2 text-xs text-muted hover:text-foreground bg-surface-hover rounded-lg transition-colors shrink-0"
        >
          {visible ? "إخفاء" : "إظهار"}
        </button>
      </div>
    </div>
  );
}

/** بطاقة مهمة نصية (اختيار نموذج من السجل + برومت قابل للتعديل) */
function TaskCard({
  label,
  description,
  defaultPrompt,
  models,
  modelId,
  prompt,
  onModelChange,
  onPromptChange,
}: {
  label: string;
  description: string;
  defaultPrompt: string;
  models: ModelConfig[];
  modelId: string | null;
  prompt: string;
  onModelChange: (id: string | null) => void;
  onPromptChange: (v: string) => void;
}) {
  const isDefault = prompt === defaultPrompt;
  return (
    <div className="p-3 rounded-xl bg-background border border-border space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="text-sm font-bold text-foreground">{label}</span>
          <p className="text-[10px] text-muted">{description}</p>
        </div>
      </div>

      {/* اختيار النموذج */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted shrink-0 w-24">النموذج</label>
        <select
          value={modelId ?? ""}
          onChange={(e) => onModelChange(e.target.value || null)}
          className="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-primary transition-colors"
        >
          <option value="">— اختر نموذجاً —</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {(m.name || "بدون اسم") + (m.model ? ` · ${m.model}` : "")}
            </option>
          ))}
        </select>
      </div>

      {/* البرومت */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted">البرومت (تعليمات النظام)</label>
          <button
            onClick={() => onPromptChange(defaultPrompt)}
            disabled={isDefault}
            className="text-[10px] text-primary hover:text-primary-hover font-medium disabled:text-muted/50 disabled:cursor-not-allowed transition-colors"
          >
            استعادة الافتراضي
          </button>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          rows={6}
          dir="rtl"
          className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-xs leading-relaxed text-foreground focus:outline-none focus:border-primary transition-colors resize-y font-mono"
        />
      </div>
    </div>
  );
}
