import type {
  AppConfig,
  DiscoveredSession,
  ManagedSession,
  TabSpec,
  WindowSpec,
} from "../types.js";

/**
 * Layout helpers: deterministic color assignment and grouping of discovered
 * sessions into Windows Terminal windows + tabs for snapshot/restore.
 */

/** A pleasant, high-contrast palette for auto-assigned tab colors. */
const PALETTE = [
  "#3B82F6", // blue
  "#10B981", // green
  "#F59E0B", // amber
  "#EF4444", // red
  "#8B5CF6", // violet
  "#EC4899", // pink
  "#06B6D4", // cyan
  "#84CC16", // lime
  "#F97316", // orange
  "#14B8A6", // teal
  "#A855F7", // purple
  "#EAB308", // gold
];

/** Stable hash → palette color, so the same key always maps to the same color. */
export function assignColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

/** The window-grouping key for a session given the configured strategy. */
export function groupKeyFor(
  s: DiscoveredSession,
  grouping: AppConfig["windowGrouping"],
): string {
  if (grouping === "single") return "all";
  if (grouping === "by-cwd") return s.cwd || "unknown";
  return s.repository || s.gitRoot || s.cwd || "unknown";
}

function colorFor(s: DiscoveredSession, strategy: AppConfig["colorStrategy"]): string {
  switch (strategy) {
    case "by-cwd":
      return assignColor(s.cwd || s.id);
    case "rotate":
      return assignColor(s.id);
    case "fixed":
      return PALETTE[0];
    case "by-repo":
    default:
      return assignColor(s.repository || s.gitRoot || s.cwd || s.id);
  }
}

/** Build a TabSpec for a session, applying managed overrides then strategy defaults. */
export function tabFor(
  s: DiscoveredSession,
  managed: ManagedSession | undefined,
  config: Pick<AppConfig, "colorStrategy">,
): TabSpec {
  const title = managed?.title ?? s.name ?? s.id.slice(0, 8);
  const color = managed?.color ?? colorFor(s, config.colorStrategy);
  return { sessionId: s.id, title, color, cwd: s.cwd };
}

/** Group sessions into ordered WindowSpecs by the configured grouping strategy. */
export function buildWindows(
  sessions: DiscoveredSession[],
  managedById: Map<string, ManagedSession>,
  config: Pick<AppConfig, "windowGrouping" | "colorStrategy">,
): WindowSpec[] {
  const groups = new Map<string, TabSpec[]>();
  for (const s of sessions) {
    const key = groupKeyFor(s, config.windowGrouping);
    const tab = tabFor(s, managedById.get(s.id), config);
    const list = groups.get(key);
    if (list) {
      list.push(tab);
    } else {
      groups.set(key, [tab]);
    }
  }
  let i = 0;
  const windows: WindowSpec[] = [];
  for (const [label, tabs] of groups) {
    windows.push({ id: `w${i++}`, label, tabs });
  }
  return windows;
}
