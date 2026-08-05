#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 *  fetch-ffmpeg.mjs — جلب ثنائي FFmpeg وتجهيزه كـ sidecar لـ Tauri
 *
 *  يضع الناتج في src-tauri/binaries/ffmpeg-<target-triple>[.exe]
 *  وهو الاسم الذي يتوقّعه bundle.externalBin في tauri.conf.json.
 *
 *  البناء المستخدم: GPL (يتضمّن libx264 و libmp3lame — وكلاهما
 *  مطلوب في commands.rs). راجع LICENSE-THIRD-PARTY.txt.
 *
 *  الاستخدام:
 *    node scripts/fetch-ffmpeg.mjs            # يتخطّى إن كان موجوداً
 *    node scripts/fetch-ffmpeg.mjs --force    # يعيد التنزيل
 * ═══════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readdirSync, statSync, copyFileSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = join(ROOT, "src-tauri", "binaries");
const CACHE_DIR = join(BIN_DIR, ".cache");
const FORCE = process.argv.includes("--force");

/** مصادر البناء لكل منصّة — روابط "latest" ثابتة الاسم من BtbN. */
const SOURCES = {
  win32: {
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    archive: "ffmpeg-win64-gpl.zip",
    innerName: "ffmpeg.exe",
  },
  linux: {
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
    archive: "ffmpeg-linux64-gpl.tar.xz",
    innerName: "ffmpeg",
  },
};

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

/** الـ target triple الحقيقي للمضيف — من rustc لا من التخمين. */
function hostTriple() {
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const m = out.match(/^host:\s*(\S+)$/m);
    if (m) return m[1];
  } catch {
    /* rustc غير متاح */
  }
  fail("تعذّر تشغيل rustc لتحديد الـ target triple. ثبّت Rust ثم أعد المحاولة.");
}

async function download(url, dest) {
  console.log(`↓ تنزيل: ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) fail(`فشل التنزيل (HTTP ${res.status}): ${url}`);
  const total = Number(res.headers.get("content-length") || 0);
  const chunks = [];
  let received = 0;
  let lastPct = -1;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    received += chunk.length;
    if (total) {
      const pct = Math.floor((received / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        process.stdout.write(`  ${pct}%  (${(received / 1048576).toFixed(1)} MB)\n`);
      }
    }
  }
  const buf = Buffer.concat(chunks);
  writeFileSync(dest, buf);
  return buf;
}

/**
 * التحقّق من SHA-256. مصدر البصمة المتوقّعة بالترتيب:
 *   1) ملف .sha256 منشور بجانب الأرشيف (إن وُجد)
 *   2) البصمة المسجّلة في binaries/SOURCE.json من جلب سابق (تثبيت TOFU)
 *
 * BtbN لا ينشر بصمات لوسم `latest`، فالتثبيت المسجّل هو خطّ الدفاع العملي:
 * أي تغيّر لاحق في الملف المنزَّل يوقف البناء بدل أن يمرّ صامتاً.
 */
async function verify(url, buf) {
  const actual = createHash("sha256").update(buf).digest("hex");

  let expected = null;
  let origin = "";
  try {
    const res = await fetch(`${url}.sha256`, { redirect: "follow" });
    if (res.ok) {
      expected = (await res.text()).trim().split(/\s+/)[0].toLowerCase();
      origin = "ملف .sha256 المنشور";
    }
  } catch {
    /* لا يوجد ملف hash منشور */
  }

  if (!expected) {
    const lockPath = join(BIN_DIR, "SOURCE.json");
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        if (lock.url === url && typeof lock.sha256 === "string") {
          expected = lock.sha256.toLowerCase();
          origin = "SOURCE.json (بصمة مثبّتة من جلب سابق)";
        }
      } catch {
        /* سجلّ تالف — نتجاهله */
      }
    }
  }

  if (!expected) {
    console.warn(
      `⚠ لا توجد بصمة مرجعية — هذا أول جلب لهذا الرابط.\n` +
        `  ستُثبَّت البصمة التالية في SOURCE.json وتُفرَض في كل جلب لاحق:\n  ${actual}`
    );
    return actual;
  }

  if (expected !== actual) {
    fail(
      `عدم تطابق SHA-256 (المرجع: ${origin})!\n` +
        `  المتوقّع: ${expected}\n  المحسوب: ${actual}\n` +
        `  إن كان BtbN قد حدّث بناء "latest" عمداً، احذف src-tauri/binaries/SOURCE.json وأعد الجلب بعد المراجعة.`
    );
  }
  console.log(`✓ تحقّق SHA-256 (${origin}): ${actual.slice(0, 16)}…`);
  return actual;
}

/**
 * فكّ الضغط عبر tar (يدعم zip و tar.xz على ويندوز 10+ ولينكس).
 *
 * على ويندوز نستدعي bsdtar من System32 صراحةً: لو كان Git Bash في الـ PATH
 * فإن `tar` قد يشير إلى GNU tar، وهو يفسّر `D:\…` كمضيف بعيد ويفشل.
 */
function extract(archivePath, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  console.log("⇱ فكّ الضغط…");

  let tarBin = "tar";
  if (process.platform === "win32") {
    const bsdtar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (existsSync(bsdtar)) tarBin = bsdtar;
  }
  execFileSync(tarBin, ["-xf", archivePath, "-C", outDir], { stdio: "inherit" });
}

/** بحث تكراري عن الثنائي داخل شجرة الأرشيف المفكوكة. */
function findBinary(dir, name) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      const found = findBinary(full, name);
      if (found) return found;
    } else if (entry === name) {
      return full;
    }
  }
  return null;
}

async function main() {
  const platform = process.platform;
  const source = SOURCES[platform];
  if (!source) {
    fail(
      `المنصّة "${platform}" غير مدعومة آلياً في هذا السكربت.\n` +
        `  على macOS: نزّل بناء GPL من https://evermeet.cx/ffmpeg/ (x86_64)\n` +
        `  أو https://osxexperts.net (arm64)، ثم ضع الثنائي في:\n` +
        `  src-tauri/binaries/ffmpeg-<target-triple>`
    );
  }

  const triple = hostTriple();
  const ext = platform === "win32" ? ".exe" : "";
  const dest = join(BIN_DIR, `ffmpeg-${triple}${ext}`);

  if (existsSync(dest) && !FORCE) {
    console.log(`✓ الـ sidecar موجود مسبقاً: ${dest}`);
    console.log("  (استخدم --force لإعادة التنزيل)");
    return;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  const archivePath = join(CACHE_DIR, source.archive);
  const buf = await download(source.url, archivePath);
  const hash = await verify(source.url, buf);

  const workDir = join(CACHE_DIR, "extract");
  extract(archivePath, workDir);

  const found = findBinary(workDir, source.innerName);
  if (!found) fail(`لم يُعثر على ${source.innerName} داخل الأرشيف.`);

  mkdirSync(BIN_DIR, { recursive: true });
  copyFileSync(found, dest);
  if (platform !== "win32") chmodSync(dest, 0o755);

  // حفظ نصّ رخصة البناء كما شحنه المصدر — التزام GPL يتطلّب مرافقتها للثنائي
  const license = findBinary(workDir, "LICENSE.txt") || findBinary(workDir, "COPYING.GPLv3");
  if (license) copyFileSync(license, join(BIN_DIR, "FFMPEG-LICENSE.txt"));
  else console.warn("⚠ لم يُعثر على ملف رخصة داخل الأرشيف — راجع LICENSE-THIRD-PARTY.txt يدوياً.");

  rmSync(workDir, { recursive: true, force: true });
  rmSync(archivePath, { force: true });

  const sizeMb = (statSync(dest).size / 1048576).toFixed(1);
  console.log(`\n✓ جاهز: ${dest}  (${sizeMb} MB)`);

  // تحقّق نهائي: هل يعمل الثنائي، وهل فيه libx264 فعلاً؟
  const version = execFileSync(dest, ["-version"], { encoding: "utf8" }).split("\n")[0];
  console.log(`  ${version}`);

  // سجلّ المصدر والبصمة والإصدار — يوثّق ما شُحن فعلاً، ويُستشهد به في
  // LICENSE-THIRD-PARTY.txt للوفاء بشرط تحديد البناء المقابل لشيفرة GPL
  writeFileSync(
    join(BIN_DIR, "SOURCE.json"),
    JSON.stringify({ url: source.url, sha256: hash, triple, version, fetchedAt: new Date().toISOString() }, null, 2) +
      "\n"
  );
  const encoders = execFileSync(dest, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  for (const codec of ["libx264", "libmp3lame", "aac"]) {
    if (!encoders.includes(codec)) fail(`البناء المنزَّل لا يحتوي المرمّز المطلوب: ${codec}`);
  }
  console.log("  ✓ المرمّزات المطلوبة متوفّرة: libx264 · libmp3lame · aac");
}

main().catch((e) => fail(e.stack || String(e)));
