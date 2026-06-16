/**
 * Pure, DOM-free helpers for searching, sorting, and grouping the session list.
 *
 * Keeping these here (rather than inline in components) lets them be unit-tested
 * under the node-only vitest environment without a DOM.
 */
import type { SessionView } from "../api/client";

/** Sort orderings offered by the toolbar. */
export type SortKey = "recent" | "name" | "repo" | "liveness";

/** Quick filter chips that narrow the visible set. */
export type QuickFilter = "missing-cwd" | "has-children";

/** Rank used so live sessions sort ahead of stale, then inactive. */
const LIVENESS_RANK: Record<SessionView["liveness"], number> = {
  live: 0,
  stale: 1,
  inactive: 2,
};

/** The best human-facing label for a session (managed title, name, or id head). */
export function displayName(session: SessionView): string {
  if (session.title && session.title.trim()) return session.title;
  if (session.name && session.name.trim()) return session.name;
  return session.id.split("-")[0] || session.id;
}

/** Concatenate the searchable fields of a session into one lowercased haystack. */
function haystack(session: SessionView): string {
  return [
    session.title,
    session.name,
    session.repository,
    session.branch,
    session.cwd,
    session.gitRoot,
    session.summary,
    session.id,
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join("\n")
    .toLowerCase();
}

/**
 * Filter sessions by a free-text query. The query is tokenized on whitespace and
 * every token must appear somewhere in the searchable fields (AND semantics).
 */
export function searchSessions(sessions: SessionView[], query: string): SessionView[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return sessions;
  return sessions.filter((s) => {
    const hay = haystack(s);
    return tokens.every((t) => hay.includes(t));
  });
}

/** Apply the active quick-filter chips (AND semantics across chips). */
export function applyQuickFilters(
  sessions: SessionView[],
  active: readonly QuickFilter[],
): SessionView[] {
  if (active.length === 0) return sessions;
  return sessions.filter((s) =>
    active.every((chip) => {
      if (chip === "missing-cwd") return !s.cwdExists || !s.cwd;
      if (chip === "has-children") return (s.childCount ?? 0) > 0;
      return true;
    }),
  );
}

function timeValue(iso?: string): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function compareBy(a: SessionView, b: SessionView, key: SortKey): number {
  switch (key) {
    case "name":
      return displayName(a).localeCompare(displayName(b), undefined, { sensitivity: "base" });
    case "repo": {
      const ra = (a.repository ?? a.gitRoot ?? a.cwd ?? "").toLowerCase();
      const rb = (b.repository ?? b.gitRoot ?? b.cwd ?? "").toLowerCase();
      return ra.localeCompare(rb);
    }
    case "liveness":
      return LIVENESS_RANK[a.liveness] - LIVENESS_RANK[b.liveness];
    case "recent":
    default:
      return timeValue(b.updatedAt) - timeValue(a.updatedAt);
  }
}

/**
 * Sort sessions by the chosen key. Pinned sessions always float to the top, and
 * `updatedAt` (most recent first) is the stable tiebreaker for every key.
 */
export function sortSessions(sessions: SessionView[], key: SortKey): SessionView[] {
  return sessions.slice().sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    const primary = compareBy(a, b, key);
    if (primary !== 0) return primary;
    return timeValue(b.updatedAt) - timeValue(a.updatedAt);
  });
}

/** The repository-grouping key for a session, falling back to git root then cwd. */
export function groupKeyFor(session: SessionView): string {
  return session.repository || session.gitRoot || session.cwd || "(unknown)";
}

/** A repository group: a stable key, a display label, and its member sessions. */
export interface SessionGroup {
  key: string;
  label: string;
  sessions: SessionView[];
}

/**
 * Bucket sessions by repository (then git root, then cwd). Groups are ordered by
 * label; the order of sessions within each group is preserved from the input.
 */
export function groupByRepo(sessions: SessionView[]): SessionGroup[] {
  const groups = new Map<string, SessionView[]>();
  for (const s of sessions) {
    const key = groupKeyFor(s);
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }
  return Array.from(groups.entries())
    .map(([key, members]) => ({ key, label: key, sessions: members }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Live children of a primary session, derived from a flat live list by groupPid. */
export function childrenOf(primary: SessionView, live: SessionView[]): SessionView[] {
  if (primary.groupPid === undefined) return [];
  return live.filter((s) => s.groupPid === primary.groupPid && s.id !== primary.id);
}
