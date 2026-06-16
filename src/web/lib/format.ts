/** Small, dependency-free formatting helpers shared by the web UI. */

/** Shorten a UUID-ish id to its first segment for compact display. */
export function shortId(id: string): string {
  const head = id.split("-")[0];
  return head ? head : id;
}

interface RelativeUnit {
  /** Upper bound (exclusive) in seconds for which this unit applies. */
  limit: number;
  /** Number of seconds per one of this unit. */
  div: number;
  /** Short suffix appended after the count. */
  unit: string;
}

const RELATIVE_UNITS: RelativeUnit[] = [
  { limit: 60, div: 1, unit: "s" },
  { limit: 3600, div: 60, unit: "m" },
  { limit: 86400, div: 3600, unit: "h" },
  { limit: 604800, div: 86400, unit: "d" },
  { limit: 2629800, div: 604800, unit: "w" },
];

const SECONDS_PER_MONTH = 2629800;

/** Render an ISO timestamp as a compact relative time, e.g. "5m ago". */
export function relativeTime(iso?: string): string {
  if (!iso) return "unknown";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 5) return "just now";
  const abs = Math.abs(seconds);
  for (const { limit, div, unit } of RELATIVE_UNITS) {
    if (abs < limit) return `${Math.floor(abs / div)}${unit} ago`;
  }
  return `${Math.floor(abs / SECONDS_PER_MONTH)}mo ago`;
}

/** Format an ISO timestamp as a localized absolute string for tooltips. */
export function absoluteTime(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}
