import type { NextConfig } from "next";

// Tauri serves the static export from ../out; there is no Node server at runtime.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // The floating dev badge overlaps the app's own controls.
  devIndicators: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
