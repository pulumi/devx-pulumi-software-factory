import { createHash } from "node:crypto";

/** Deterministic UUID (v5-style, SHA-1) so a retried transition reuses the same requestId and Factory dedupes it. */
export function uuidFrom(name: string, namespace = "agent-factory-triage"): string {
  const h = createHash("sha1").update(namespace).update("\0").update(name).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Content hash: same title/body => same decision key, edited issue => re-evaluated. */
export function contentHash(...parts: Array<string | undefined | null>): string {
  return createHash("sha256").update(parts.map((p) => p ?? "").join("\u0001")).digest("hex").slice(0, 16);
}
