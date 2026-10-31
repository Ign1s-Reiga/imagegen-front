import type { Metadata } from "next";

import { PixelView } from "@/components/pixel/PixelView";

export const metadata: Metadata = { title: "Pixel | ImageGen" };

export default function PixelPage() {
  return <PixelView />;
}
