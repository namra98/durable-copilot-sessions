/**
 * Shared domain types for durable-copilot-sessions.
 *
 * These types form the contract between the discovery, registry, launch,
 * snapshot, server, CLI, and web layers. Keep this file free of runtime
 * imports so it can be consumed by both Node and browser code.
 */

/** A Copilot CLI session id (UUID), e.g. "dccd6a05-847c-4b1e-9d45-7d380410d68a". */
export type CopilotSessionId = string;

/** Liveness classification for a discovered session. */
export type SessionLiveness = "live" | "stale" | "inactive";

/**
 * A Copilot session discovered on disk by scanning
 * ~/.copilot/session-state/<id>/workspace.yaml (+ session-store.db enrichment +
 * inuse.<pid>.lock liveness).
 */
export interface DiscoveredSession {
  /** Copilot session id (folder name under session-state). */
  id: CopilotSessionId;
  /** Working directory the session was started in (resume must use this cwd). */
  cwd: string;
  /** Whether `cwd` currently exists on disk. */
  cwdExists: boolean;
  /** Human-friendly session name from workspace.yaml `name`, if any. */
  name?: string;
  /** Latest summary text from session-store.db `sessions.summary`, if available. */
  summary?: string;
  /** git_root from workspace.yaml, if the session was in a git repo. */
  gitRoot?: string;
  /** "owner/repo" from workspace.yaml `repository`, if known. */
  repository?: string;
  /** git branch from workspace.yaml `branch`, if known. */
  branch?: string;
  /** Copilot client that created the session, e.g. "github/cli". */
  clientName?: string;
  /** ISO timestamp the session was created. */
  createdAt?: string;
  /** ISO timestamp the session was last updated. */
  updatedAt?: string;
  /** Liveness based on inuse.*.lock files and whether their PIDs are alive. */
  liveness: SessionLiveness;
  /** PIDs that currently hold a lock on this session (alive processes only). */
  livePids: number[];
  /**
   * Best-effort flag: a top-level interactive session (vs a subagent/background
   * child session). Used as the default filter for "save current layout".
   */
  topLevel: boolean;
  /** Parent session id when created via fork/branch (workspace.yaml `branch_of`). */
  branchOf?: string;
  /** Free-text lineage note written at fork time (workspace.yaml `branch_note`). */
  branchNote?: string;
}

/** A natural color name or #RRGGBB / RRGGBB hex string for a Windows Terminal tab. */
export type TabColor = string;

/** Which Windows Terminal window a relaunch should target. */
export type WindowTarget = "new" | "current";

/**
 * The launch specification for a single Windows Terminal tab that resumes one
 * Copilot session.
 */
export interface TabSpec {
  /** Copilot session to resume in this tab. */
  sessionId: CopilotSessionId;
  /** Windows Terminal tab title. */
  title: string;
  /** Windows Terminal tab color (name or hex). */
  color: TabColor;
  /** Working directory to launch in (defaults to the session's recorded cwd). */
  cwd: string;
  /** Extra Copilot CLI args (e.g. ["--allow-all-tools"]). */
  copilotArgs?: string[];
}

/** A logical Windows Terminal window grouping one or more tabs. */
export interface WindowSpec {
  /** Local identifier for the window within a workspace. */
  id: string;
  /** Optional window title / label (purely descriptive). */
  label?: string;
  /** Tabs to open in this window, in order. */
  tabs: TabSpec[];
}

/** How a workspace came to exist. */
export type WorkspaceSource = "manual" | "auto-snapshot" | "imported";

/**
 * A named, restorable layout: a set of Windows Terminal windows, each with
 * ordered tabs that resume Copilot sessions. This is the durable artifact that
 * survives reboots.
 */
export interface Workspace {
  /** Tool-owned UUID for the workspace (not a Copilot session id). */
  id: string;
  /** Human-friendly workspace name, e.g. "morning-layout". */
  name: string;
  /** Optional longer description. */
  description?: string;
  /** How the workspace was created. */
  source: WorkspaceSource;
  /** ISO timestamp created. */
  createdAt: string;
  /** ISO timestamp last updated. */
  updatedAt: string;
  /** Windows + tabs to relaunch. */
  windows: WindowSpec[];
}

/**
 * Tool-owned metadata for a session the user has customized (title/color/etc).
 * Keyed by Copilot session id. Lets discovered sessions remember a chosen color
 * and title across restarts even when launched manually.
 */
export interface ManagedSession {
  sessionId: CopilotSessionId;
  /** Overrides the discovered name for display and tab title. */
  title?: string;
  /** Preferred tab color. */
  color?: TabColor;
  /** Grouping key used to bucket tabs into windows on restore. */
  group?: string;
  /** Pinned sessions sort first and are always included in snapshots. */
  pinned?: boolean;
  /** Hidden sessions are excluded from the default UI list and snapshots. */
  hidden?: boolean;
  /** User-assigned tags for filtering/organization. */
  tags?: string[];
  /** Archived sessions are hidden from the default list (kept for history). */
  archived?: boolean;
  /** ISO timestamp this metadata was last touched. */
  updatedAt: string;
}

/** Strategy for auto-assigning tab colors when the user has not chosen one. */
export type ColorStrategy = "by-repo" | "by-cwd" | "rotate" | "fixed";

/** Persisted user configuration. */
export interface AppConfig {
  /** Local API/server port. */
  apiPort: number;
  /** Web dev server port (Vite). */
  webPort: number;
  /** Minutes between background auto-snapshots. */
  snapshotIntervalMinutes: number;
  /** Maximum number of rolling auto-snapshots to retain. */
  maxAutoSnapshots: number;
  /** Default color assignment strategy. */
  colorStrategy: ColorStrategy;
  /** Open the browser automatically when running `dcs ui`. */
  autoOpenBrowser: boolean;
  /** When grouping discovered sessions into windows, group tabs by this key. */
  windowGrouping: "by-repo" | "by-cwd" | "single";
  /**
   * Executable used to launch Copilot in a tab. Defaults to "copilot". Set to a
   * wrapper (e.g. "agency") when Copilot is started through one.
   */
  copilotCommand: string;
  /**
   * Base arguments inserted before `--resume`/`-i` on every launch (e.g.
   * ["copilot", "--mcp", "workiq", ..., "--yolo"] when copilotCommand is a wrapper).
   */
  copilotArgs: string[];
  /** Behavior of the logon scheduled task: do nothing, prompt, or auto-restore. */
  restoreOnLogin: "off" | "prompt" | "auto";
}

/** Result of launching one or more Windows Terminal tabs. */
export interface LaunchResult {
  /** Whether the wt.exe invocation(s) succeeded. */
  ok: boolean;
  /** Number of tabs launched. */
  tabsLaunched: number;
  /** Number of windows opened. */
  windowsOpened: number;
  /** Any non-fatal warnings (e.g. cwd missing, fell back to git root). */
  warnings: string[];
  /** Error message if ok is false. */
  error?: string;
}

/** Options for resuming a single session as a new tab. */
export interface ResumeOptions {
  sessionId: CopilotSessionId;
  title?: string;
  color?: TabColor;
  cwd?: string;
  /** Ordered fallback directories used when `cwd` no longer exists. */
  fallbacks?: string[];
  window?: WindowTarget;
  copilotArgs?: string[];
  /** Executable used to launch Copilot (defaults to "copilot"). */
  copilotCommand?: string;
  /** When true, build the command but do not execute wt.exe. */
  dryRun?: boolean;
}

/* ------------------------------------------------------------------ *
 * Session graph (canvas) model
 * ------------------------------------------------------------------ */

/** A node in the session graph: one Copilot session. */
export interface GraphNode {
  id: CopilotSessionId;
  label: string;
  repository?: string;
  branch?: string;
  cwd: string;
  color?: TabColor;
  liveness: SessionLiveness;
  role?: "primary" | "child";
  /** True when this session was created via fork (has a branchOf parent). */
  isFork: boolean;
  /** Number of co-located child sessions (for primaries). */
  childCount: number;
}

/** Relationship kinds rendered as graph edges. */
export type GraphEdgeKind = "fork" | "terminal" | "repo";

/** An edge between two graph nodes. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
}

/** The full session graph plus the honest open-terminal count. */
export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  openCount: number;
}

/* ------------------------------------------------------------------ *
 * Local memory / recall model
 * ------------------------------------------------------------------ */

/** Classification of an extracted memory. */
export type MemoryKind = "summary" | "decision" | "todo" | "learning" | "file_context" | "chat";

/** A durable, recallable unit extracted from a session. */
export interface Memory {
  id: string;
  sessionId: CopilotSessionId;
  kind: MemoryKind;
  title?: string;
  content: string;
  repository?: string;
  branch?: string;
  cwd?: string;
  /** Source table in session-store.db (e.g. "checkpoints", "sessions"). */
  sourceTable: string;
  /** Source row reference (e.g. checkpoint id, turn index). */
  sourceRef?: string;
  createdAt: number;
  updatedAt: number;
}

/** A single memory search result with its relevance score. */
export interface MemorySearchHit {
  memory: Memory;
  score: number;
  snippet?: string;
}

/** A compact bundle of memory to inject as context into a new/forked session. */
export interface MemoryRecallPack {
  repository?: string;
  branch?: string;
  decisions: Memory[];
  todos: Memory[];
  summaries: Memory[];
  files: string[];
}

