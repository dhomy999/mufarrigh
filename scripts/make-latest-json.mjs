#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 *  make-latest-json.mjs — توليد بيان التحديث latest.json
 *
 *  التطبيق يسأل هذا الملف: «هل ثمّة إصدار أحدث؟». يجب أن يُرفع
 *  مع كل release، وإلا فلن يرى أحد التحديث.
 *
 *  يقرأ الإصدار من tauri.conf.json، ويلتقط المثبّت وملفّ توقيعه
 *  (.sig) من مجلد البناء، ويبني الروابط على وسم الإصدار.
 *
 *  الاستخدام:
 *    node scripts/make-latest-json.mjs                 # ملاحظات من CHANGELOG
 *    node scripts/make-latest-json.mjs --notes "نصّ"   # ملاحظات صريحة
 * ═══════════════════════════════════════════════════════════════
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "dhomy999/mufarrigh";

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
const tag = `v${version}`;

/** المنصّات المدعومة ومواضع مثبّتاتها داخل مجلد البناء */
const PLATFORMS = [
  {
    key: "windows-x86_64",
    dir: join(ROOT, "src-tauri/target/release/bundle/nsis"),
    match: (f) => f.endsWith("-setup.exe"),
  },
  {
    key: "darwin-aarch64",
    dir: join(ROOT, "src-tauri/target/release/bundle/macos"),
    match: (f) => f.endsWith(".app.tar.gz"),
  },
  {
    key: "linux-x86_64",
    dir: join(ROOT, "src-tauri/target/release/bundle/appimage"),
    match: (f) => f.endsWith(".AppImage"),
  },
];

const platforms = {};
for (const p of PLATFORMS) {
  if (!existsSync(p.dir)) continue;
  const files = readdirSync(p.dir);
  const artifact = files.find(p.match);
  if (!artifact) continue;

  const sigFile = files.find((f) => f === `${artifact}.sig`);
  if (!sigFile) {
    fail(
      `عُثر على ${artifact} بلا ملف توقيع (.sig).\n` +
        `  حزم التحديث يجب أن تُوقَّع، وإلا رفضها التطبيق.\n` +
        `  ابنِ مع ضبط TAURI_SIGNING_PRIVATE_KEY_PATH.`
    );
  }

  platforms[p.key] = {
    signature: readFileSync(join(p.dir, sigFile), "utf8").trim(),
    // GitHub يرمّز المحارف غير اللاتينية في الروابط — نرمّزها هنا لتطابق
    url: `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(basename(artifact))}`,
  };
  console.log(`✓ ${p.key}: ${artifact}`);
}

if (Object.keys(platforms).length === 0) {
  fail("لم يُعثر على أي مثبّت في مجلد البناء. شغّل `npm run tauri build` أولاً.");
}

/** الملاحظات: من سطر الأوامر، وإلا من سجلّ التغييرات المشحون مع التطبيق */
function notesFromChangelog() {
  const src = readFileSync(join(ROOT, "src/lib/changelog.ts"), "utf8");
  // نلتقط مدخل الإصدار الحالي ونستخرج نصوص التغييرات منه
  const entry = src.split(`version: "${version}"`)[1];
  if (!entry) return "";
  const block = entry.split("],")[0];
  const lines = [...block.matchAll(/text:\s*"([^"]+)"/g)].map((m) => `• ${m[1]}`);
  return lines.join("\n");
}

const notesArgIndex = process.argv.indexOf("--notes");
const notes =
  notesArgIndex !== -1 ? process.argv[notesArgIndex + 1] : notesFromChangelog();

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

const outPath = join(ROOT, "src-tauri/target/release/bundle/latest.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`\n✓ ${outPath}`);
console.log(`  الإصدار: ${version}   الوسم: ${tag}`);
console.log(`  ارفع هذا الملف مع المثبّت في نفس الـ release.`);
