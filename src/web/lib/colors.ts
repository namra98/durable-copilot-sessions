import type { SessionView } from "../api/client";

/**
 * A curated palette of distinct, Windows-Terminal-compatible swatches used for
 * the inline color picker and for auto-assigning colors to unmanaged sessions.
 */
export const COLOR_SWATCHES: readonly string[] = [
  "#ef4444", // red
  "#f97316", // orange
  "#f59e0b", // amber
  "#eab308", // yellow
  "#84cc16", // lime
  "#22c55e", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#a855f7", // purple
  "#ec4899", // pink
];

/** A handful of common Windows Terminal color names mapped to hex for display. */
const NAMED_COLORS: Record<string, string> = {
  red: "#ef4444",
  orange: "#f97316",
  amber: "#f59e0b",
  yellow: "#eab308",
  lime: "#84cc16",
  green: "#22c55e",
  teal: "#14b8a6",
  cyan: "#06b6d4",
  blue: "#3b82f6",
  indigo: "#6366f1",
  purple: "#a855f7",
  violet: "#a855f7",
  magenta: "#ec4899",
  pink: "#ec4899",
  gray: "#94a3b8",
  grey: "#94a3b8",
};

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** Normalize a stored color (hex, bare hex, or WT name) to a CSS color string. */
export function toCssColor(color: string): string {
  const trimmed = color.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("#")) return trimmed;
  const named = NAMED_COLORS[trimmed.toLowerCase()];
  if (named) return named;
  if (/^[0-9a-f]{6}$/i.test(trimmed)) return `#${trimmed}`;
  return trimmed;
}

/** Deterministically pick a swatch for a session lacking an explicit color. */
export function autoColor(session: SessionView): string {
  const key = session.repository ?? session.gitRoot ?? session.cwd ?? session.id;
  return COLOR_SWATCHES[hashString(key) % COLOR_SWATCHES.length];
}

/** The effective display color for a session: managed color or an auto color. */
export function resolveColor(session: SessionView): string {
  if (session.color && session.color.trim()) return toCssColor(session.color);
  return autoColor(session);
}
