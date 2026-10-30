import type { Metadata } from "next";

import { ConnectionsView } from "@/components/connections/ConnectionsView";

export const metadata: Metadata = { title: "Connections | ImageGen" };

export default function ConnectionsPage() {
  return <ConnectionsView />;
}
