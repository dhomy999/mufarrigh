"use client";

/**
 * ═══════════════════════════════════════════════════════════════
 *  lib/secure-storage.ts
 *  تشفير مفاتيح الـ API خارج localStorage (plan.md §5.3)
 *
 *  يستخدم Web Crypto:
 *    - PBKDF2 (SHA-256, 150k تكرار) لاستخلاص مفتاح من كلمة المرور
 *    - AES-GCM (256-bit) للتشفير/فك التشفير
 *
 *  لا يُخزَّن أي نصّ صريح على القرص. عند اختيار التشفير، تُستبدل
 *  المفاتيح بنصّ مشفّر + Salt + IV، ولا تُفَكّ إلا بعد إدخال كلمة المرور
 *  في الجلسة.
 * ═══════════════════════════════════════════════════════════════
 */

import type { ProviderKeys } from "./settings";

const PBKDF2_ITERATIONS = 150_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** بنية التخزين عند تفعيل التشفير */
interface EncryptedBlob {
  /** إصدار المخطّط (للتوافق المستقبلي) */
  v: 1;
  /** قاعدة 64 */
  salt: string;
  iv: string;
  ciphertext: string;
}

/** حالة التخزين: إما نصّ صريح (قديم) أو مشفّر (جديد) */
export type SecurePayload =
  | { kind: "plain"; keys: ProviderKeys }
  | { kind: "encrypted"; blob: EncryptedBlob };

const STORAGE_KEY = "arabic-video-editor:keys-v3";

function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase) as BufferSource,
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** يشفّر المفاتيح بكلمة مرور ويعيد الـ blob للتخزين */
export async function encryptKeys(
  keys: ProviderKeys,
  passphrase: string
): Promise<EncryptedBlob> {
  if (!passphrase) throw new Error("كلمة المرور مطلوبة");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(keys));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext as BufferSource
  );
  return {
    v: 1,
    salt: toB64(salt),
    iv: toB64(iv),
    ciphertext: toB64(ciphertext),
  };
}

/** يفك تشفير الـ blob بكلمة مرور */
export async function decryptKeys(
  blob: EncryptedBlob,
  passphrase: string
): Promise<ProviderKeys> {
  const salt = fromB64(blob.salt);
  const iv = fromB64(blob.iv);
  const key = await deriveKey(passphrase, salt);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      fromB64(blob.ciphertext) as BufferSource
    );
  } catch {
    throw new Error("كلمة المرور غير صحيحة");
  }
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/** يحفظ حالة المفاتيح (نصّ صريح أو مشفّر) */
export function saveSecurePayload(payload: SecurePayload): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

/** يسترجع حالة المفاتيح المخزّنة */
export function loadSecurePayload(): SecurePayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.kind === "plain" && parsed.keys) return parsed;
    if (parsed?.kind === "encrypted" && parsed.blob) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** يُزيل التخزين */
export function clearSecureStorage(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}

/** يتحقّق من توفّر Web Crypto (بيئة آمنة) */
export function hasWebCrypto(): boolean {
  return typeof window !== "undefined" && !!window.crypto?.subtle;
}