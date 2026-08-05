<div dir="rtl">

# محرر الفيديو العربي

تطبيق سطح مكتب لتفريغ المحاضرات والدروس العربية وتحريرها **عبر النصّ**: تُفرَّغ المادة الصوتية أو المرئية آلياً، ثم يحرّر المستخدم النصّ — فينعكس التحرير على الفيديو أو يخرج مستنداً منسّقاً.

مبني على Tauri 2 (Rust) + Next.js 16.

---

## المساران

| | 📝 مسار النصّ | 🎬 مسار الفيديو |
|---|---|---|
| **الجمهور** | مفرّغو النصوص | صانعو المقاطع القصيرة |
| **المخرجات** | DOCX / SRT | MP4 / Shorts / SRT |
| **الواجهة** | `TextStudio` — فقرات متدفّقة | `VideoStudio` — شرائح وخطّ زمني |

كلاهما يقرأ نفس المخزن (`TranscriptDocument` في `src/core/document/`). تفاصيل المعمارية في [`PLAN.md`](PLAN.md)، ووصف الميزات في [`FEATURES.md`](FEATURES.md).

---

## المتطلّبات

- Node.js 20+
- Rust 1.77.2+ ‏(`rustc` مطلوب في الـ PATH — السكربتات تستخرج منه الـ target triple)
- [متطلّبات Tauri 2 لنظامك](https://v2.tauri.app/start/prerequisites/)

**لا حاجة لتثبيت FFmpeg يدوياً** — يُجلب آلياً ويُشحن داخل التطبيق.

---

## التشغيل للتطوير

```bash
npm install
npm run ffmpeg:fetch     # مرة واحدة: يجلب ثنائي FFmpeg إلى src-tauri/binaries/
npm run tauri dev
```

في وضع التطوير، إن لم يوجد الـ sidecar يسقط التطبيق تلقائياً إلى نسخة FFmpeg المثبّتة على النظام (إن وُجدت).

---

## بناء المثبّت

```bash
npm run tauri build
```

`beforeBuildCommand` يشغّل `npm run bundle` الذي يجلب الـ sidecar قبل بناء الواجهة، فلا يخرج مثبّت بلا FFmpeg. المخرجات في `src-tauri/target/release/bundle/`.

**على ويندوز يُبنى مثبّت NSIS فقط، وMSI مستبعَد عمداً:** أداة WiX3 التي يستخدمها Tauri لبناء MSI تكتب جداولها بترميز code page 1252، فتفشل على اسم المنتج العربي بالخطأ `LGHT0311`. أما NSIS فيدعم UTF-8، وله واجهة تثبيت عربية مفعّلة هنا مع مبدّل لغة. لإعادة MSI لاحقاً (للنشر المؤسّسي مثلاً) يلزم اسم منتج لاتيني أو ضبط `Codepage` في قالب WiX مخصّص.

### عن ثنائي FFmpeg

يُجلب عبر [`scripts/fetch-ffmpeg.mjs`](scripts/fetch-ffmpeg.mjs) من [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds).

- **بناء GPL** لأن الترميز يستخدم `libx264` (`commands.rs:1606` و`:2730`)، وهو غير متاح في بناءات LGPL.
- السكربت **يثبّت بصمة SHA-256 عند أول جلب** في `src-tauri/binaries/SOURCE.json` ويفرضها فيما بعد؛ فأي تبدّل في الملف المنزَّل يوقف البناء بدل أن يمرّ صامتاً. عند تحديث FFmpeg عمداً: احذف `SOURCE.json` ثم `npm run ffmpeg:fetch -- --force`.
- macOS غير مدعوم آلياً في السكربت بعد — يُنزَّل الثنائي يدوياً ويوضع باسم `ffmpeg-<target-triple>` داخل `src-tauri/binaries/`.

⚠️ **قيد رخصي:** شحن بناء GPL يعني أن التطبيق يُوزَّع مجاناً/مفتوحاً. لتوزيع مغلق المصدر، استبدله ببناء LGPL وحوّل الترميز إلى `libopenh264`. التفاصيل في [`LICENSE-THIRD-PARTY.txt`](LICENSE-THIRD-PARTY.txt).

---

## إصدار نسخة جديدة

التطبيق يحدّث نفسه هوائياً: يقرأ `latest.json` من آخر release على GitHub، وإن وجد إصداراً أحدث عرض على المستخدم تنزيله وتثبيته، ثم أظهر له «ما الجديد» بعد إعادة التشغيل.

**خطوات الإصدار:**

1. ارفع رقم الإصدار في ثلاثة مواضع معاً: `package.json` و`src-tauri/tauri.conf.json` و`src-tauri/Cargo.toml`.
2. أضف مدخلاً للإصدار في `src/lib/changelog.ts` — هذا ما يراه المستخدم في نافذة «ما الجديد».
3. ابنِ **مع مفتاح التوقيع** في البيئة:

   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/mufarrigh-updater.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
   npm run tauri build
   ```

   > المتغيّر يأخذ **محتوى** المفتاح لا مساره. و`TAURI_SIGNING_PRIVATE_KEY_PATH` المذكور في مخرجات `signer generate` لا يعمل في هذه النسخة من الـ CLI — يفشل البناء عند التحزيم برسالة «A public key has been found, but no private key».

4. ولّد بيان التحديث: `npm run release:manifest`
5. أنشئ release بالوسم `vX.Y.Z` وارفع فيه **المثبّت و`latest.json` معاً**.

### مفتاح التوقيع — لا بديل عنه

التطبيق يرفض أي حزمة تحديث لا يطابق توقيعها المفتاح العامّ المضمَّن في `tauri.conf.json`. هذا ما يمنع أن يُحقَن في أجهزة المستخدمين تحديثٌ مزوَّر.

المفتاح الخاص في `~/.tauri/mufarrigh-updater.key` — **خارج المستودع، وفقدانه يعني أن كل من ثبّت التطبيق لن يستطيع التحديث مرة أخرى أبداً** ولا سبيل لإصلاح ذلك إلا بمطالبتهم بإعادة التثبيت يدوياً. خذ نسخة احتياطية منه في مكان آمن.

**ملاحظة:** وُلّد المفتاح بلا كلمة مرور. إن أردت تشديد ذلك، ولّد بديلاً بكلمة مرور — لكن قبل أن يثبّت أحد الإصدار الأول، لأن تغيير المفتاح بعد النشر يكسر تحديثات من ثبّتوا.

---

## الأوامر

| الأمر | الوظيفة |
|---|---|
| `npm run tauri dev` | تشغيل التطبيق للتطوير |
| `npm run tauri build` | بناء المثبّت |
| `npm run ffmpeg:fetch` | جلب الـ sidecar (يتخطّى إن وُجد؛ `-- --force` لإعادة الجلب) |
| `npm run release:manifest` | توليد `latest.json` من مخرجات البناء |
| `npm run lint` | فحص ESLint |
| `npx tsc --noEmit` | فحص الأنواع |

---

## المفاتيح والخصوصية

التطبيق يتطلّب مفاتيح API لخدمات التفريغ (Groq / OpenAI / Speechmatics) ونماذج النصّ. **يُرسَل صوت المستخدم إلى مزوّد التفريغ المختار** — وهذا إفصاح واجب لأي مستخدم.

تُخزَّن المفاتيح محلياً، ويمكن تشفيرها بكلمة مرور عبر `src/lib/secure-storage.ts` ‏(AES-GCM + PBKDF2). التشفير اختياري حالياً وغير مفعّل افتراضياً.

---

## الرخصة

التطبيق: MIT (انظر [`LICENSE`](LICENSE)).
المكوّنات الخارجية — وأهمّها FFmpeg بترخيص GPL v3: [`LICENSE-THIRD-PARTY.txt`](LICENSE-THIRD-PARTY.txt).

</div>
