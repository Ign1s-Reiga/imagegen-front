import { resolveConfig } from "@/lib/secrets";
import { midSentence } from "@/lib/text";
import { service } from "@/providers/registry";
import type { ConnectionConfig } from "@/providers/types";
import type { Assistant } from "@/store/app";

/** The assistant connection's settings and keys, or an error that says what is missing. */
export async function assistantConfig(assistant: Assistant): Promise<ConnectionConfig> {
  const config = await resolveConfig(assistant.connection);
  const missing = service(assistant.connection.kind).fields.filter((f) => f.required && !config[f.key]?.trim());
  if (missing.length) {
    throw new Error(
      `${assistant.connection.name} needs ${missing.map((f) => midSentence(f.label)).join(" and ")}. Add it in Connections.`,
    );
  }
  return config;
}
