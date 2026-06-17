/**
 * Pure, DOM-free helpers for the Insights view: bar-chart scaling and CSV
 * serialization. Kept here so they can be unit-tested under the node-only
 * vitest environment.
 */

/**
 * Scale a series of non-negative values to pixel heights in `[0, maxPx]`.
 *
 * The largest value maps to `maxPx`; the rest scale linearly. Any strictly
 * positive value is clamped up to at least `minPx` so a tiny-but-present bar
 * stays visible. Zero values map to 0. An empty/all-zero series yields zeros.
 */
export function scaleBars(values: number[], maxPx: number, minPx = 2): number[] {
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  if (max <= 0 || maxPx <= 0) return values.map(() => 0);
  return values.map((v) => {
    if (v <= 0) return 0;
    const px = (v / max) * maxPx;
    return Math.max(minPx, Math.round(px));
  });
}

/** Escape a single CSV field, quoting it when it contains a comma, quote, or newline. */
export function csvField(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialize a list of row objects to CSV. `headers` fixes column order; when
 * omitted, the keys of the first row are used. Always emits a header line; uses
 * CRLF line endings for spreadsheet compatibility.
 */
export function toCsv(
  rows: Array<Record<string, string | number>>,
  headers?: string[],
): string {
  const cols = headers ?? (rows.length > 0 ? Object.keys(rows[0]) : []);
  const lines = [cols.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => csvField(row[c] ?? "")).join(","));
  }
  return lines.join("\r\n");
}
