"use client";

import { ParamsPanel } from "./ParamsPanel";
import { SessionStrip } from "./SessionStrip";
import { Stage } from "./Stage";

export function GenerateView() {
  return (
    <div className="flex h-full">
      <ParamsPanel />
      <Stage />
      <SessionStrip />
    </div>
  );
}
