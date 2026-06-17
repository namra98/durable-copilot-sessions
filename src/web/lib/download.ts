/**
 * Client-side download helper: turn an in-memory string into a saved file via a
 * transient object URL and a synthetic anchor click. DOM-only — not unit-tested
 * under the node vitest environment (its pure inputs live in {@link sanitizeFilename}).
 */

/** Strip characters that are unsafe in a download filename, keeping it readable. */
export function sanitizeFilename(name: string, fallback = "download"): string {
  const withoutControls = Array.from(name)
    .filter((ch) => ch.charCodeAt(0) >= 0x20)
    .join("");
  const cleaned = withoutControls
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .trim();
  return cleaned || fallback;
}

/** Trigger a browser download of `text` as `filename` with the given MIME type. */
export function triggerDownload(filename: string, text: string, mime = "application/json"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has a chance to start the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
