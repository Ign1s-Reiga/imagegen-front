/** The readable message in an error body: a JSON API's message, or the raw text. */
function bodyMessage(body: string): string {
  let detail = body.trim();
  try {
    const json = JSON.parse(body);
    // OpenRouter shortens the provider's error in `message` (ending it with
    // "…") and passes the provider's own body whole in `metadata.raw`.
    const raw = json?.error?.metadata?.raw;
    const upstream = typeof raw === "string" ? bodyMessage(raw) : raw ? bodyMessage(JSON.stringify(raw)) : "";
    detail =
      upstream ||
      (json?.error?.message ??
        json?.detail?.[0]?.msg ??
        (typeof json?.detail === "string" ? json.detail : undefined) ??
        json?.message ??
        json?.error ??
        detail);
    if (typeof detail !== "string") detail = JSON.stringify(detail);
    // e.g. RunPod answers 401 with {"error":{}}
    if (detail === "{}" || detail === "[]") detail = "";
  } catch {
    // Not JSON; keep the raw text.
  }
  return detail;
}

/**
 * The most of a body's message kept: enough for a full provider error (with
 * a list of violations or a validation report) to read in the error window,
 * while a server's whole HTML error page is still cut short.
 */
const MAX_DETAIL = 4000;

/** One line for a failed HTTP response: the host, the status and what the body says. */
export function describeHttpError(status: number, body: string, url: string): string {
  const detail = bodyMessage(body);
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  return `${host} returned ${status}${detail ? `: ${detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail}` : ""}`;
}
