import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "./globals.css";

// خط Cairo العربي — يدعم العربية واللاتينية بكفاءة
const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "محرر الفيديو العربي",
  description: "تحرير الفيديو عبر النص — مخصص للغة العربية",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ar"
      dir="rtl"
      className={`${cairo.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
        {children}
      </body>
    </html>
  );
}
