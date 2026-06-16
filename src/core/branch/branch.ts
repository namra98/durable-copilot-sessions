import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import { copilotSessionStateDir } from "../paths.js";

/**
 * TS-native session fork, mirroring the session-branch skill's branch_session.py:
 * copy a session directory into a new one, rewrite identity + lineage in
 * workspace.yaml (`branch_of`/`branch_note`), rewrite the session.start event,
 * reset rewind/checkpoint history, and drop the per-session DB and stale locks.
 *
 * IMPORTANT: this only ever CREATES a new directory under the session-state dir;
 * it never modifies the parent (or any existing) session. The copy skips the
 * parent's `session.db*` and lock files so forking a LIVE session is safe.
 */

export interface ForkResult {
  newSessionId: string;
  newSessionName: string;
  newSessionPath: string;
  parentId: string;
}

export interface ForkOptions {
  note?: string;
  /** Override the session-state dir (tests). Defaults to Copilot's. */
  stateDir?: string;
  /** Override the generated id (tests). */
  newId?: string;
}

const CHECKPOINT_INDEX_HEADER =
  "# Checkpoint History\n\n" +
  "Checkpoints are listed in chronological order. Checkpoint 1 is the oldest, " +
  "higher numbers are more recent.\n\n" +
  "| # | Title | File |\n" +
  "|---|-------|------|\n";

const REWIND_INDEX_JSON = '{"version":1,"snapshots":[],"filePathMap":{}}\n';

const SKIP_COPY_RE = /^(session\.db(-shm|-wal)?|inuse\.\d+\.lock)$/;

/** Synchronous sleep (no deps) for the rename retry loop. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename with retry. On Windows a just-written directory can be transiently
 * locked (antivirus, search indexer), making renameSync fail with EPERM/EBUSY;
 * retry a few times before giving up.
 */
function renameWithRetry(from: string, to: string, attempts = 12, delayMs = 50): void {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (i >= attempts - 1 || !["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"].includes(code)) {
        throw err;
      }
      sleepSync(delayMs);
    }
  }
}

/** Collapse whitespace and truncate to a short single-line title. */
function compact(value: string, maxLen = 72): string {
  const v = (value || "").split(/\s+/).filter(Boolean).join(" ");
  if (v.length <= maxLen) return v;
  return v.slice(0, maxLen - 3).trimEnd() + "...";
}

/** Branch `parentId` into a new session directory. Returns the new identity. */
export function branchSession(parentId: string, opts: ForkOptions = {}): ForkResult {
  const stateDir = opts.stateDir ?? copilotSessionStateDir;
  const currentDir = path.join(stateDir, parentId);
  const workspacePath = path.join(currentDir, "workspace.yaml");
  if (!fs.existsSync(workspacePath)) {
    throw new Error(`Missing workspace metadata: ${workspacePath}`);
  }

  const newId = opts.newId ?? randomUUID();
  const newDir = path.join(stateDir, newId);
  if (fs.existsSync(newDir)) {
    throw new Error(`Branch destination already exists: ${newDir}`);
  }

  const srcDoc = parseDocument(fs.readFileSync(workspacePath, "utf8"));
  const rawName = srcDoc.get("name");
  const rawSummary = srcDoc.get("summary");
  const baseTitle =
    (typeof rawName === "string" && rawName) ||
    (typeof rawSummary === "string" && rawSummary) ||
    `Session ${parentId.slice(0, 8)}`;
  const branchTitle = `Branch: ${compact(String(baseTitle))} [${newId.slice(0, 8)}]`;
  const now = new Date().toISOString();

  fs.mkdirSync(stateDir, { recursive: true });
  const staging = path.join(stateDir, `.tmp-branch-${randomUUID().replace(/-/g, "")}`);

  try {
    // Copy the session, skipping the (possibly locked) DB and lock files.
    fs.cpSync(currentDir, staging, {
      recursive: true,
      filter: (src) => !SKIP_COPY_RE.test(path.basename(src)),
    });

    // Rewrite identity + lineage in workspace.yaml.
    const stagingWorkspace = path.join(staging, "workspace.yaml");
    const doc = parseDocument(fs.readFileSync(stagingWorkspace, "utf8"));
    doc.set("id", newId);
    doc.set("name", branchTitle);
    doc.set("user_named", true);
    doc.set("summary", branchTitle);
    doc.set("created_at", now);
    doc.set("updated_at", now);
    doc.set("branch_of", parentId);
    doc.set(
      "branch_note",
      opts.note && opts.note.trim()
        ? opts.note.trim()
        : `Branched from: ${baseTitle} (${parentId})`,
    );
    fs.writeFileSync(stagingWorkspace, doc.toString(), "utf8");

    rewriteSessionStart(path.join(staging, "events.jsonl"), newId, branchTitle);
    resetRewind(staging);
    resetCheckpoints(staging);

    // Atomic move into place.
    renameWithRetry(staging, newDir);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  return {
    newSessionId: newId,
    newSessionName: branchTitle,
    newSessionPath: newDir,
    parentId,
  };
}

/** Update the session.start event's identity, if events.jsonl exists. */
function rewriteSessionStart(eventsPath: string, newId: string, branchTitle: string): void {
  if (!fs.existsSync(eventsPath)) return;
  const lines = fs.readFileSync(eventsPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const out: string[] = [];
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      out.push(line);
      continue;
    }
    if (event.type === "session.start") {
      const data = (event.data ?? {}) as Record<string, unknown>;
      data.sessionId = newId;
      if ("alreadyInUse" in data) data.alreadyInUse = false;
      for (const k of ["name", "title", "summary"]) {
        if (k in data) data[k] = branchTitle;
      }
      event.data = data;
    }
    out.push(JSON.stringify(event));
  }
  fs.writeFileSync(eventsPath, out.join("\n") + "\n", "utf8");
}

function resetRewind(staging: string): void {
  const rewindDir = path.join(staging, "rewind-snapshots");
  fs.mkdirSync(rewindDir, { recursive: true });
  fs.writeFileSync(path.join(rewindDir, "index.json"), REWIND_INDEX_JSON, "utf8");
  const backupDir = path.join(rewindDir, "backups");
  if (fs.existsSync(backupDir)) {
    for (const child of fs.readdirSync(backupDir)) {
      fs.rmSync(path.join(backupDir, child), { recursive: true, force: true });
    }
  }
}

function resetCheckpoints(staging: string): void {
  const checkpointDir = path.join(staging, "checkpoints");
  fs.mkdirSync(checkpointDir, { recursive: true });
  fs.writeFileSync(path.join(checkpointDir, "index.md"), CHECKPOINT_INDEX_HEADER, "utf8");
}
