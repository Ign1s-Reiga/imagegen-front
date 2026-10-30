import { invoke } from "@tauri-apps/api/core";

import type { Connection, ConnectionConfig } from "@/providers/types";
import { provider } from "@/providers/registry";

const secretKey = (connectionId: string, field: string) => `connection:${connectionId}:${field}`;

export const getSecret = (connectionId: string, field: string) =>
  invoke<string | null>("secret_get", { key: secretKey(connectionId, field) });

export const setSecret = (connectionId: string, field: string, value: string) =>
  invoke<void>("secret_set", { key: secretKey(connectionId, field), value });

export const deleteSecret = (connectionId: string, field: string) =>
  invoke<void>("secret_delete", { key: secretKey(connectionId, field) });

function secretFields(connection: Connection) {
  return provider(connection.kind).fields.filter((f) => f.type === "secret");
}

/** Saved config plus keychain secrets: what provider adapters receive. */
export async function resolveConfig(connection: Connection): Promise<ConnectionConfig> {
  const config: ConnectionConfig = { ...connection.config };
  for (const field of secretFields(connection)) {
    const value = await getSecret(connection.id, field.key);
    if (value) config[field.key] = value;
  }
  return config;
}

export async function deleteConnectionSecrets(connection: Connection) {
  await Promise.all(secretFields(connection).map((f) => deleteSecret(connection.id, f.key)));
}
