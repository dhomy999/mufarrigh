/**
 * ═══════════════════════════════════════════════════════════════
 *  core/export/docx.ts
 *  تصدير DOCX صحيح الاتجاه (RTL) — plan.md الملحق أ
 *
 *  يلتزم بـ:
 *    - <w:bidi/> على خصائص الفقرة (paragraph)
 *    - <w:rtl/> على خصائص التشغيل (run)
 *    - خط عربي واضح، حجم 14
 *    - صفحة غلاف، فهرس تلقائي عند وجود عناوين، طوابع زمنية اختيارية
 * ═══════════════════════════════════════════════════════════════
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  PageBreak,
  convertInchesToTwip,
} from "docx";
import type {
  Paragraph as DocParagraph,
  TranscriptDocument,
} from "../document/types";
import type { VerseMatch } from "../religion/quran";

const ARABIC_FONT = "Arial"; // خط واضح ومتوفر يدعم العربية
const FONT_SIZE_HALF_PT = 28; // 14pt

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/** فقرة محتوى: كلمات الفقرة مدمجة بنصّ واحد، بترقيم وRTL صحيح */
function buildContentParagraph(
  p: DocParagraph,
  doc: TranscriptDocument,
  withTimestamp: boolean,
  verseMatches: VerseMatch[]
): Paragraph {
  const startIdx = doc.tokens.findIndex((t) => t.id === p.startTokenId);
  const endIdx = doc.tokens.findIndex((t) => t.id === p.endTokenId);
  const tokens = doc.tokens
    .slice(Math.max(0, startIdx), endIdx + 1)
    .filter((t) => t.kind === "word" && t.status !== "removed");

  // كشف الآيات الواقعة داخل هذه الفقرة (plan.md §3.4)
  const startId = tokens[0]?.id;
  const endId = tokens[tokens.length - 1]?.id;
  const versesInPara = verseMatches.filter(
    (v) =>
      startId &&
      endId &&
      tokenIdIndex(v.startTokenId, tokens) >= 0 &&
      tokenIdIndex(v.endTokenId, tokens) >= 0
  );

  const children: (TextRun | Paragraph)[] = [];
  if (withTimestamp && tokens.length > 0 && tokens[0].start != null) {
    children.push(
      new TextRun({
        text: `[${formatTimestamp(tokens[0].start!)}] `,
        bold: true,
        font: ARABIC_FONT,
      })
    );
  }

  // إذا وُجدت آية، نلفّ نطاق كلّ آية بـ ﴿ ﴾ ونضيف المرجع بعدها
  if (versesInPara.length > 0) {
    children.push(...buildVerseRuns(tokens, versesInPara));
  } else {
    const text = tokens.map((t) => t.text).join(" ");
    children.push(new TextRun({ text, font: ARABIC_FONT }));
  }

  // إضافة مرجع الآية في سطر منفصل تحت الفقرة إن وُجدت
  for (const v of versesInPara) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `﴾ ${v.suraName} • آية ${v.aya} ﴿`,
            italics: true,
            font: ARABIC_FONT,
            color: "1E7E34",
          }),
        ],
        bidirectional: true,
        alignment: AlignmentType.RIGHT,
        spacing: { before: 60, after: 60 },
      })
    );
  }

  return new Paragraph({
    children,
    bidirectional: true,
    alignment: AlignmentType.RIGHT,
    spacing: { after: 160, line: 320 },
  });
}

/** يُحوّل التوكِنات إلى TextRuns مع لفّ نطاقات الآيات بـ ﴿ ﴾ */
function buildVerseRuns(
  tokens: { id: string; text: string; start?: number }[],
  verses: VerseMatch[]
): TextRun[] {
  // نبني خريطة: tokenId → verse
  const verseByToken = new Map<string, VerseMatch>();
  for (const v of verses) {
    let inside = false;
    for (const t of tokens) {
      if (t.id === v.startTokenId) inside = true;
      if (inside) verseByToken.set(t.id, v);
      if (t.id === v.endTokenId) break;
    }
  }
  const runs: TextRun[] = [];
  let buffer: string[] = [];
  let currentVerse: VerseMatch | null = null;
  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.join(" ");
    if (currentVerse) {
      runs.push(
        new TextRun({
          text: `﴿ ${text} ﴾`,
          font: ARABIC_FONT,
          bold: true,
          color: "1E7E34",
        })
      );
    } else {
      runs.push(new TextRun({ text, font: ARABIC_FONT }));
    }
    buffer = [];
  };
  for (const t of tokens) {
    const v = verseByToken.get(t.id) ?? null;
    if (v !== currentVerse) {
      flush();
      currentVerse = v;
    }
    buffer.push(t.text);
  }
  flush();
  return runs;
}

/** فهرس التوكِن بالمعرّف ضمن قائمة (أو -1) */
function tokenIdIndex(id: string, tokens: { id: string }[]): number {
  for (let i = 0; i < tokens.length; i++) if (tokens[i].id === id) return i;
  return -1;
}

/** عنوان فقرة (heading) */
function buildHeading(heading: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: heading, bold: true, font: ARABIC_FONT })],
    heading: HeadingLevel.HEADING_2,
    bidirectional: true,
    alignment: AlignmentType.RIGHT,
    spacing: { before: 320, after: 160 },
  });
}

/** سطر فهرس: اسم العنوان فقط (الفهارس الحقيقية تتطلّب تحديث وورد) */
function buildTocEntry(heading: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: heading, font: ARABIC_FONT })],
    bidirectional: true,
    alignment: AlignmentType.RIGHT,
    spacing: { after: 80 },
  });
}

export interface DocxOptions {
  /** عنوان المستند (صفحة الغلاف) */
  title?: string;
  /** إضافة صفحة غلاف (افتراضي: true) */
  titlePage?: boolean;
  /** إضافة فهرس للعناوين إن وُجدت (افتراضي: true) */
  toc?: boolean;
  /** إدراج الطابع الزمني قبل كل فقرة (افتراضي: false) */
  timestamps?: boolean;
  /** مطابقات آيات قرآنية لتنسيقها بـ ﴿ ﴾ (plan.md §3.4) */
  verseMatches?: VerseMatch[];
}

/** يبني مستند DOCX من المستند الموحّد ويُرجع Blob */
export async function buildDocx(
  doc: TranscriptDocument,
  opts: DocxOptions = {}
): Promise<Blob> {
  const {
    title = "مفرّغ المحاضرة",
    titlePage = true,
    toc = true,
    timestamps = false,
    verseMatches = [],
  } = opts;

  const headings = doc.paragraphs.filter((p) => p.heading && p.heading.length > 0);
  const hasHeadings = headings.length > 0;

  const children: Paragraph[] = [];

  // صفحة الغلاف
  if (titlePage) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: title, bold: true, size: 56, font: ARABIC_FONT }),
        ],
        bidirectional: true,
        alignment: AlignmentType.CENTER,
        spacing: { before: 3600, after: 2400 },
      })
    );
    children.push(
      new Paragraph({
        children: [new PageBreak()],
      })
    );
  }

  // الفهرس
  if (toc && hasHeadings) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "الفهرس", bold: true, size: 36, font: ARABIC_FONT }),
        ],
        bidirectional: true,
        alignment: AlignmentType.RIGHT,
        spacing: { after: 240 },
      })
    );
    for (const h of headings) children.push(buildTocEntry(h.heading!));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  // المحتوى
  for (const p of doc.paragraphs) {
    if (p.heading && p.heading.length > 0) children.push(buildHeading(p.heading));
    children.push(buildContentParagraph(p, doc, timestamps, verseMatches));
  }

  const d = new Document({
    creator: "Aravid",
    title,
    styles: {
      default: {
        document: {
          run: {
            font: ARABIC_FONT,
            size: FONT_SIZE_HALF_PT,
            rightToLeft: true,
          },
          paragraph: {
            alignment: AlignmentType.RIGHT,
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
          },
        },
        children,
      },
    ],
  });

  return await Packer.toBlob(d);
}