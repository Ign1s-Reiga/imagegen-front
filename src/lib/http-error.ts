/** The message a JSON error body names in one of the fields APIs use, if any. */
function knownMessage(json: unknown): string | undefined {
  const j = json as { error?: unknown; detail?: unknown; message?: unknown } | null;
  const error = j?.error as { message?: unknown } | undefined;
  const detail = j?.detail as { msg?: unknown }[] | string | undefined;
  const found =
    error?.message ??
    (Array.isArray(detail) ? detail[0]?.msg : undefined) ??
    (typeof detail === "string" ? detail : undefined) ??
    j?.message ??
    (typeof j?.error === "string" ? j.error : undefined);
  return typeof found === "string" && found ? found : undefined;
}

/**
 * The provider's own message from an OpenRouter error, when OpenRouter's is
 * shortened (it ends with "…") and the provider's body in `metadata.raw` has
 * it whole: in a message field, or as text that starts the same way. Raw
 * bodies with neither (an HTML page, JSON with no message) are not used.
 */
function providerMessage(json: unknown): string | undefined {
  const error = (json as { error?: { message?: unknown; metadata?: { raw?: unknown } } } | null)?.error;
  const message = error?.message;
  const raw = error?.metadata?.raw;
  if (typeof message !== "string" || !message.endsWith("…") || raw == null) return undefined;
  let text = typeof raw === "string" ? raw.trim() : "";
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const found = knownMessage(parsed);
    if (found) return found;
    text = "";
  } catch {
    // Plain text; used only if it is the message OpenRouter shortened.
  }
  const shortened = message.slice(0, -1).trim();
  return shortened && text.startsWith(shortened) ? text : undefined;
}

/** The readable message in an error body: a JSON API's message, or the raw text. */
function bodyMessage(body: string): string {
  let detail = body.trim();
  try {
    const json = JSON.parse(body);
    const found = providerMessage(json) ?? knownMessage(json);
    detail = found ?? (json?.error && typeof json.error === "object" ? JSON.stringify(json.error) : detail);
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

/** The first `max` UTF-16 units of `text`, one fewer if that would split an emoji's surrogate pair. */
function cut(text: string, max: number): string {
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

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
  return `${host} returned ${status}${detail ? `: ${detail.length > MAX_DETAIL ? `${cut(detail, MAX_DETAIL)}…` : detail}` : ""}`;
}
