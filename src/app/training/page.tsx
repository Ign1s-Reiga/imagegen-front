import type { Metadata } from "next";

import { TrainingView } from "@/components/training/TrainingView";

export const metadata: Metadata = { title: "Training | ImageGen" };

export default function TrainingPage() {
  return <TrainingView />;
}
