import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import type { DiscoveredSession, SessionLiveness } from "../types.js";
import { copilotSessionStateDir, copilotSessionStoreDb } from "../paths.js";

/**
 * Read-only discovery of Copilot CLI sessions from disk.
 *
 * Sessions live one folder per id under ~/.copilot/session-state/<id>/, each
 * with a workspace.yaml. Liveness is derived from inuse.<pid>.lock files plus a
 * PID-aliveness probe. An optional best-effort pass enriches sessions with a
 * `summary` from the global ~/.copilot/session-store.db SQLite index. We never
 * write to any of Copilot's state.
 */

/** Options for {@link listSessions} / {@link getSession}; overridable for tests. */
export interface ListOptions {
  /** Directory holding one folder per Copilot session. Defaults to Copilot's. */
  sessionStateDir?: string;
  /** SQLite index used for summary enrichment. Defaults to Copilot's. */
  sessionStoreDb?: string;
  /** Injectable running-process snapshot (pid -> image name). For tests. */
  processSnapshot?: ProcessSnapshot;
  /**
   * When true, skip non-live sessions without parsing their workspace.yaml.
   * A large optimization for the default "open"/"live" views (only ~live dirs
   * are read instead of all 1000+).
   */
  liveOnly?: boolean;
  /**
   * Reserved. Discovery always returns every parsed session; callers filter.
   * Kept in the signature for forward compatibility.
   */
  includeAll?: boolean;
}

/** Raw, untrusted shape of a workspace.yaml. Every field may be absent. */
interface WorkspaceYaml {
  id?: unknown;
  cwd?: unknown;
  git_root?: unknown;
  repository?: unknown;
  branch?: unknown;
  client_name?: unknown;
  name?: unknown;
  user_named?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

/** Filenames look like `inuse.12316.lock`; capture the PID. */
const LOCK_FILE_RE = /^inuse\.(\d+)\.lock$/;

/** Client name used by the top-level interactive Copilot CLI. */
const CLI_CLIENT_NAME = "github/cli";

/**
 * Whether a process id is currently alive.
 *
 * Uses the signal-0 probe: success means the process exists. EPERM means it
 * exists but we lack permission to signal it (still alive); ESRCH (or anything
 * else) means it is gone. Non-positive or non-integer pids are never alive.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

/** Map of running process id -> executable image name (lower-cased). */
export type ProcessSnapshot = Map<number, string>;

let snapshotCache: { at: number; snap: ProcessSnapshot } | undefined;

/**
 * Snapshot running processes (pid -> image name) via `tasklist`. Cached briefly
 * so repeated discovery calls don't re-spawn it. Returns an empty map on any
 * failure, in which case callers fall back to a bare PID-liveness probe.
 */
export function getProcessSnapshot(): ProcessSnapshot {
  const now = Date.now();
  if (snapshotCache && now - snapshotCache.at < 2500) {
    return snapshotCache.snap;
  }
  const snap: ProcessSnapshot = new Map();
  // Only enumerate the images that can hold a Copilot session lock; a filtered
  // tasklist is ~4x faster than enumerating every process.
  for (const image of ["copilot.exe", "node.exe"]) {
    try {
      const res = spawnSync(
        "tasklist",
        ["/fi", `imagename eq ${image}`, "/fo", "csv", "/nh"],
        { encoding: "utf8" },
      );
      if (res.status === 0 && res.stdout) {
        for (const line of res.stdout.split(/\r?\n/)) {
          const m = /^"([^"]+)","(\d+)"/.exec(line);
          if (m) {
            snap.set(Number(m[2]), m[1].toLowerCase());
          }
        }
      }
    } catch {
      // tasklist unavailable (e.g. non-Windows); leave this image out.
    }
  }
  snapshotCache = { at: now, snap };
  return snap;
}

/** Image names that identify a Copilot CLI process holding a session lock. */
const COPILOT_PROC_RE = /copilot|node/i;

/**
 * Whether `pid` currently belongs to a live Copilot process. With a process
 * snapshot we require the image name to look like Copilot/node, which rejects
 * dead locks and PID reuse by unrelated processes. Without a snapshot we fall
 * back to a bare signal-0 liveness probe.
 */
function pidIsLiveCopilot(pid: number, snapshot: ProcessSnapshot): boolean {
  if (snapshot.size > 0) {
    const name = snapshot.get(pid);
    return name !== undefined && COPILOT_PROC_RE.test(name);
  }
  return isPidAlive(pid);
}

/** Coerce a YAML scalar to a non-empty string, else undefined. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Coerce a YAML timestamp (string or Date) to an ISO string, else undefined. */
function optionalTimestamp(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return undefined;
}

/** Parsed-millis of `updatedAt`, or undefined when missing/unparseable. */
function updatedAtMillis(session: DiscoveredSession): number | undefined {
  if (!session.updatedAt) {
    return undefined;
  }
  const millis = Date.parse(session.updatedAt);
  return Number.isNaN(millis) ? undefined : millis;
}

/** Sort live sessions first, then by updatedAt descending with missing last. */
function sortSessions(sessions: DiscoveredSession[]): void {
  sessions.sort((a, b) => {
    const aLive = a.liveness === "live" ? 1 : 0;
    const bLive = b.liveness === "live" ? 1 : 0;
    if (aLive !== bLive) {
      return bLive - aLive;
    }
    const aMillis = updatedAtMillis(a);
    const bMillis = updatedAtMillis(b);
    if (aMillis !== undefined && bMillis !== undefined) {
      return bMillis - aMillis;
    }
    if (aMillis !== undefined) {
      return -1;
    }
    if (bMillis !== undefined) {
      return 1;
    }
    return 0;
  });
}

/** Collect the alive PIDs holding `inuse.<pid>.lock` files, plus a lock count. */
function readLiveness(
  sessionDir: string,
  snapshot: ProcessSnapshot,
): { livePids: number[]; lockCount: number } {
  let files: string[];
  try {
    files = fs.readdirSync(sessionDir);
  } catch {
    return { livePids: [], lockCount: 0 };
  }
  const livePids: number[] = [];
  let lockCount = 0;
  for (const file of files) {
    const match = LOCK_FILE_RE.exec(file);
    if (!match) {
      continue;
    }
    lockCount += 1;
    const pid = Number(match[1]);
    if (pidIsLiveCopilot(pid, snapshot) && !livePids.includes(pid)) {
      livePids.push(pid);
    }
  }
  return { livePids, lockCount };
}

/** Build a DiscoveredSession from a session folder, or undefined to skip it. */
function readSession(
  sessionStateDir: string,
  id: string,
  snapshot: ProcessSnapshot,
  liveOnly: boolean,
): DiscoveredSession | undefined {
  const sessionDir = path.join(sessionStateDir, id);

  // Liveness first (one readdir): lets the open/live views skip parsing the
  // workspace.yaml of every inactive session.
  const { livePids, lockCount } = readLiveness(sessionDir, snapshot);
  if (liveOnly && livePids.length === 0) {
    return undefined;
  }

  const yamlPath = path.join(sessionDir, "workspace.yaml");
  let raw: string;
  try {
    raw = fs.readFileSync(yamlPath, "utf8");
  } catch {
    return undefined;
  }

  let workspace: WorkspaceYaml;
  try {
    workspace = (parse(raw) ?? {}) as WorkspaceYaml;
  } catch {
    return undefined;
  }

  const cwd = optionalString(workspace.cwd) ?? "";

  let liveness: SessionLiveness;
  if (livePids.length > 0) {
    liveness = "live";
  } else if (lockCount > 0) {
    liveness = "stale";
  } else {
    liveness = "inactive";
  }

  const clientName = optionalString(workspace.client_name);

  return {
    id,
    cwd,
    cwdExists: cwd.length > 0 && fs.existsSync(cwd),
    name: optionalString(workspace.name),
    gitRoot: optionalString(workspace.git_root),
    repository: optionalString(workspace.repository),
    branch: optionalString(workspace.branch),
    clientName,
    createdAt: optionalTimestamp(workspace.created_at),
    updatedAt: optionalTimestamp(workspace.updated_at),
    liveness,
    livePids,
    topLevel: clientName === undefined || clientName === CLI_CLIENT_NAME,
  };
}

/** Minimal structural view of the experimental node:sqlite surface we use. */
interface SqliteStatement {
  all: (...params: unknown[]) => unknown[];
}
interface SqliteDatabase {
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}
type SqliteDatabaseCtor = new (
  filename: string,
  options?: { readOnly?: boolean },
) => SqliteDatabase;

/**
 * Run `fn` while suppressing only Node's experimental-SQLite warning, so a
 * routine `dcs list` / server start does not print noise on every invocation.
 * All other warnings are forwarded unchanged.
 */
function suppressSqliteExperimentalWarning<T>(fn: () => T): T {
  const original = process.emitWarning.bind(process);
  const patched = (warning: string | Error, ...rest: unknown[]): void => {
    const message = typeof warning === "string" ? warning : warning.message;
    const mentionsExperimentalSqlite =
      /experimental/i.test(message) && /sqlite/i.test(message);
    const taggedExperimental = rest.some(
      (r) =>
        r === "ExperimentalWarning" ||
        (typeof r === "object" && r !== null && (r as { type?: unknown }).type === "ExperimentalWarning"),
    );
    if (mentionsExperimentalSqlite || (taggedExperimental && /sqlite/i.test(message))) {
      return;
    }
    (original as (w: string | Error, ...a: unknown[]) => void)(warning, ...rest);
  };
  process.emitWarning = patched as typeof process.emitWarning;
  try {
    return fn();
  } finally {
    process.emitWarning = original as typeof process.emitWarning;
  }
}

/**
 * Best-effort: attach `summary` from session-store.db to matching sessions.
 *
 * Opens the SQLite index read-only via the experimental built-in node:sqlite
 * module (loaded synchronously so this stays usable from the sync list path).
 * Any failure — module unavailable on older Node, locked/missing/corrupt db,
 * absent table — is swallowed; summaries are a nice-to-have, not a requirement.
 */
export function enrichSummaries(
  sessions: DiscoveredSession[],
  sessionStoreDb: string = copilotSessionStoreDb,
): void {
  if (sessions.length === 0 || !fs.existsSync(sessionStoreDb)) {
    return;
  }

  let DatabaseSync: SqliteDatabaseCtor | undefined;
  try {
    const req = createRequire(import.meta.url);
    DatabaseSync = suppressSqliteExperimentalWarning(
      () => (req("node:sqlite") as { DatabaseSync?: SqliteDatabaseCtor }).DatabaseSync,
    );
  } catch {
    return;
  }
  if (!DatabaseSync) {
    return;
  }
  const Ctor = DatabaseSync;

  let db: SqliteDatabase | undefined;
  try {
    db = suppressSqliteExperimentalWarning(() => new Ctor(sessionStoreDb, { readOnly: true }));
    const rows = db.prepare("SELECT id, summary FROM sessions").all() as Array<{
      id?: unknown;
      summary?: unknown;
    }>;
    const summaryById = new Map<string, string>();
    for (const row of rows) {
      if (typeof row.id === "string" && typeof row.summary === "string" && row.summary.length > 0) {
        summaryById.set(row.id, row.summary);
      }
    }
    for (const session of sessions) {
      const summary = summaryById.get(session.id);
      if (summary !== undefined) {
        session.summary = summary;
      }
    }
  } catch {
    // Enrichment is optional; ignore any failure.
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures.
    }
  }
}

/**
 * Discover every Copilot session under `sessionStateDir`.
 *
 * Folders without a readable/parseable workspace.yaml are skipped. The result
 * is sorted live-first, then by `updatedAt` descending (missing last), and is
 * enriched with summaries when the SQLite index is readable.
 */
export function listSessions(opts?: ListOptions): DiscoveredSession[] {
  const sessionStateDir = opts?.sessionStateDir ?? copilotSessionStateDir;
  const sessionStoreDb = opts?.sessionStoreDb ?? copilotSessionStoreDb;
  const snapshot = opts?.processSnapshot ?? getProcessSnapshot();
  const liveOnly = opts?.liveOnly ?? false;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionStateDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions: DiscoveredSession[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const session = readSession(sessionStateDir, entry.name, snapshot, liveOnly);
    if (session) {
      sessions.push(session);
    }
  }

  try {
    enrichSummaries(sessions, sessionStoreDb);
  } catch {
    // Never fail discovery because of optional enrichment.
  }

  sortSessions(sessions);
  return sessions;
}

/** Discover a single session by id, or undefined when it cannot be found. */
export function getSession(id: string, opts?: ListOptions): DiscoveredSession | undefined {
  const sessionStateDir = opts?.sessionStateDir ?? copilotSessionStateDir;
  const sessionStoreDb = opts?.sessionStoreDb ?? copilotSessionStoreDb;
  const snapshot = opts?.processSnapshot ?? getProcessSnapshot();
  // Read just this one session's directory rather than scanning every session.
  const session = readSession(sessionStateDir, id, snapshot, false);
  if (!session) {
    return undefined;
  }
  try {
    enrichSummaries([session], sessionStoreDb);
  } catch {
    // Enrichment is optional.
  }
  return session;
}
