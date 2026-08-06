/**
 * Transport-level guards applied before any expensive parsing, policy
 * evaluation, storage work, or model generation.
 */

/** Default ceiling for a JSON request body, in bytes. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 4096;

/** Canonical UUID string length; longer path segments are rejected early. */
export const MAX_DISCUSSION_IDENTIFIER_LENGTH = 36;

/** True when the request declares a JSON media type (with optional params). */
export function hasJsonContentType(request: Request): boolean {
  const header = request.headers.get("content-type");
  if (header === null) return false;
  const mediaType = header.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

export type BoundedBodyResult = { ok: true; text: string } | { ok: false };

/**
 * Reads a request body while refusing to buffer more than maxBytes.
 *
 * A declared Content-Length above the ceiling is rejected without reading
 * the stream. Bodies without a usable Content-Length are consumed chunk by
 * chunk and abandoned as soon as the ceiling is exceeded, so an attacker
 * cannot force unbounded buffering with a chunked body.
 */
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (Number.isInteger(length) && length > maxBytes) {
      return { ok: false };
    }
  }

  const stream = request.body;
  if (stream === null) return { ok: true, text: "" };

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { ok: true, text };
}

/**
 * Derives a network-level rate-limit key from the request.
 *
 * Uses the first entry of X-Forwarded-For when present (set by the trusted
 * proxy in front of the application), then X-Real-IP, then a shared
 * fallback for direct connections. The key is an address, never a session
 * token or Discussion identifier, and is never echoed to the client.
 */
export function clientNetworkKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}
