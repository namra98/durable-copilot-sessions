/**
 * Workspace diff: compare a durable Workspace snapshot against the live set of
 * discovered sessions to report what changed since the snapshot was taken.
 *
 * Pure, no I/O. The caller supplies the live `DiscoveredSession[]` (e.g. from
 * discovery) and the previously-saved `Workspace`.
 */

import type { DiscoveredSession, TabSpec, Workspace } from "../types.js";

/** One row in a workspace diff bucket. */
export interface WorkspaceDiffEntry {
  /** Copilot session id the entry concerns. */
  sessionId: string;
  /** Display title (tab title for workspace tabs; session name/id for live). */
  title: string;
  /** Human-readable description of the difference. */
  detail: string;
}

/** The categorized result of diffing a workspace against live sessions. */
export interface WorkspaceDiff {
  /** Tabs whose session is no longer discovered at all. */
  missing: WorkspaceDiffEntry[];
  /** Tabs whose recorded cwd is gone or differs from the live session cwd. */
  staleCwd: WorkspaceDiffEntry[];
  /** Tabs that matched but whose live branch differs meaningfully. */
  changed: WorkspaceDiffEntry[];
  /** Live sessions not referenced by any tab in the workspace. */
  addedLive: WorkspaceDiffEntry[];
  /** Count of tabs that matched cleanly with no detected difference. */
  unchanged: number;
}

/** Flatten every tab across every window of a workspace, preserving order. */
function flattenTabs(workspace: Workspace): TabSpec[] {
  const tabs: TabSpec[] = [];
  for (const window of workspace.windows) {
    for (const tab of window.tabs) {
      tabs.push(tab);
    }
  }
  return tabs;
}

/** Normalize a path for comparison (trim, unify slashes, drop trailing slash). */
function normalizeCwd(cwd: string | undefined): string {
  if (!cwd) return "";
  return cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Compare a saved workspace against the live discovered sessions.
 *
 * @param workspace The durable saved layout.
 * @param live The currently discovered sessions.
 * @returns A categorized {@link WorkspaceDiff}.
 */
export function diffWorkspace(workspace: Workspace, live: DiscoveredSession[]): WorkspaceDiff {
  const diff: WorkspaceDiff = {
    missing: [],
    staleCwd: [],
    changed: [],
    addedLive: [],
    unchanged: 0,
  };

  const liveById = new Map<string, DiscoveredSession>();
  for (const session of live) {
    liveById.set(session.id, session);
  }

  const tabs = flattenTabs(workspace);
  const referencedIds = new Set<string>();

  for (const tab of tabs) {
    referencedIds.add(tab.sessionId);
    const title = tab.title;
    const match = liveById.get(tab.sessionId);

    if (!match) {
      diff.missing.push({
        sessionId: tab.sessionId,
        title,
        detail: "session no longer discovered",
      });
      continue;
    }

    if (match.cwdExists === false) {
      diff.staleCwd.push({
        sessionId: tab.sessionId,
        title,
        detail: `cwd no longer exists: ${match.cwd}`,
      });
      continue;
    }

    if (normalizeCwd(tab.cwd) !== normalizeCwd(match.cwd)) {
      diff.staleCwd.push({
        sessionId: tab.sessionId,
        title,
        detail: `cwd changed: "${tab.cwd}" -> "${match.cwd}"`,
      });
      continue;
    }

    // cwd is fine; check for a meaningful branch change. We only have the tab's
    // cwd/title, so this is conservative: only report when the live session
    // carries a branch token in the title that no longer matches.
    if (tabImpliesBranchChange(tab, match)) {
      diff.changed.push({
        sessionId: tab.sessionId,
        title,
        detail: `branch is now "${match.branch}"`,
      });
      continue;
    }

    diff.unchanged += 1;
  }

  for (const session of live) {
    if (!referencedIds.has(session.id)) {
      diff.addedLive.push({
        sessionId: session.id,
        title: session.name ?? session.id,
        detail: "live but not in workspace",
      });
    }
  }

  return diff;
}

/**
 * Decide whether a tab's recorded state implies a branch change against the
 * live session. The tab carries no stored branch, so this stays conservative:
 * only report a change when the tab title references a branch token that no
 * longer matches the live session's branch.
 */
function tabImpliesBranchChange(tab: TabSpec, live: DiscoveredSession): boolean {
  if (!live.branch) return false;
  const rawTitle = tab.title ?? "";
  const mentionsBranch = /[@#]([\w./-]+)/.test(rawTitle);
  if (!mentionsBranch) return false;
  return !rawTitle.toLowerCase().includes(live.branch.toLowerCase());
}
