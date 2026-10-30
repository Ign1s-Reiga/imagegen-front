import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { sniffImageMime, type Bytes } from "./bytes";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(describeHttpError(status, body, url));
    this.name = "HttpError";
  }
}

function describeHttpError(status: number, body: string, url: string): string {
  let detail = body.trim();
  try {
    const json = JSON.parse(body);
    detail =
      json?.error?.message ??
      json?.detail?.[0]?.msg ??
      (typeof json?.detail === "string" ? json.detail : undefined) ??
      json?.message ??
      json?.error ??
      detail;
    if (typeof detail !== "string") detail = JSON.stringify(detail);
    // e.g. RunPod answers 401 with {"error":{}}
    if (detail === "{}" || detail === "[]") detail = "";
  } catch {
    // Not JSON; keep the raw text.
  }
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  return `${host} returned ${status}${detail ? `: ${detail.slice(0, 400)}` : ""}`;
}

export interface HttpOptions extends RequestInit {
  /**
   * Send no Origin header. ComfyUI rejects requests to loopback addresses
   * whose Origin differs from Host, and the Tauri HTTP plugin adds the
   * webview origin by default.
   */
  stripOrigin?: boolean;
}

/** fetch() routed through Rust, so CORS never applies. Throws on non-2xx. */
export async function http(url: string, options: HttpOptions = {}): Promise<Response> {
  const { stripOrigin, ...init } = options;
  const headers = new Headers(init.headers);
  if (stripOrigin) headers.set("Origin", "");
  let response: Response;
  try {
    response = await tauriFetch(url, { ...init, headers });
  } catch (err) {
    if (init.signal?.aborted) throw abortError();
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach ${url}: ${reason}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new HttpError(response.status, body, url);
  }
  return response;
}

export async function httpJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const response = await http(url, options);
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 200)}`);
  }
}

export async function httpImage(
  url: string,
  options: HttpOptions = {},
): Promise<{ bytes: Bytes; mime: string }> {
  const response = await http(url, options);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, mime: sniffImageMime(bytes, response.headers.get("content-type")) };
}

export function abortError(): DOMException {
  return new DOMException("Generation canceled", "AbortError");
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
