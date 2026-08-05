import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ✦ Tauri يتطلب ملفات ثابتة (static export) في وضع الإنتاج
  output: "export",

  // تأكد من أن الصور تعمل بدون خادم Next.js
  images: {
    unoptimized: true,
  },

  // منع التضارب مع مسارات Tauri
  trailingSlash: true,
};

export default nextConfig;
