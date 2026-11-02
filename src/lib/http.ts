import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { sniffImageMime, type Bytes } from "./bytes";
import { describeHttpError } from "./http-error";

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

/**
 * The response body parsed as JSON. A body of `null` parses, but no caller
 * expects it and reading a field from it throws a TypeError far from here, so
 * it is rejected like any other body that is not what was asked for.
 */
export async function httpJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const response = await http(url, options);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 200)}`);
  }
  if (body === null) throw new Error(`Expected JSON from ${url}, got: null`);
  return body as T;
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

/**
 * Cancels a submitted job on the backend when `signal` aborts. Submit requests
 * go out without the signal: one cut off mid-flight may still have queued the
 * job, with no id left to cancel it by. So this is called once the submit
 * returns, and a cancel pressed meanwhile is handled here: the job is
 * cancelled at once and this throws, ending the run. Returns a function that
 * stops listening, for the run's `finally`.
 */
export function cancelOnAbort(signal: AbortSignal, cancel: () => void): () => void {
  if (signal.aborted) {
    cancel();
    signal.throwIfAborted();
  }
  signal.addEventListener("abort", cancel, { once: true });
  return () => signal.removeEventListener("abort", cancel);
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
