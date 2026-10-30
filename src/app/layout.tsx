import type { Metadata } from "next";
import { Barlow, Newsreader } from "next/font/google";

import { AppShell } from "@/components/AppShell";

import "./globals.css";

const barlow = Barlow({
  variable: "--font-barlow",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "ImageGen",
  description: "Generate images with OpenAI, ComfyUI, RunPod, fal.ai, Replicate and Stable Diffusion WebUI.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${barlow.variable} ${newsreader.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
