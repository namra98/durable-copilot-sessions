import fs from "node:fs";
import { createHash } from "node:crypto";

import type { Memory, MemoryKind } from "../types.js";
import { copilotSessionStoreDb } from "../paths.js";
import { openDatabase, type SqliteDatabase } from "./sqlite.js";

/**
 * Pure, local extraction of {@link Memory} records from Copilot's read-only
 * `session-store.db`. No LLM, no network — a deterministic transform of
 * checkpoints and session summaries into durable, recallable units.
 *
 * The source database is opened read-only/immutable; this module never writes
 * to it. Extraction is defensive: a missing column, absent table, or a single
 * bad row never aborts the whole run.
 */

/** Raw checkpoints row; every column may be absent or the wrong type. */
interface CheckpointRow {
  id?: unknown;
  session_id?: unknown;
  title?: unknown;
  overview?: unknown;
  work_done?: unknown;
  technical_details?: unknown;
  important_files?: unknown;
  next_steps?: unknown;
  created_at?: unknown;
}

/** Raw sessions row used both as a join target and as a summary source. */
interface SessionRow {
  id?: unknown;
  cwd?: unknown;
  repository?: unknown;
  branch?: unknown;
  summary?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

/** Parent session metadata indexed by session id, for joining checkpoints. */
interface ParentMeta {
  repository?: string;
  branch?: string;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** Coerce any scalar to a trimmed non-empty string, else undefined. */
function str(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

/**
 * Coerce a stored timestamp to epoch milliseconds. Accepts numeric epochs (in
 * seconds or millis) and ISO strings. Returns 0 when unparseable so a memory
 * always has a sortable ordinal.
 */
function toMillis(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: 10-digit values are seconds, 13-digit are millis.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && /^\d+$/.test(value.trim())) {
      return asNum < 1e12 ? Math.round(asNum * 1000) : Math.round(asNum);
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 0;
}

/**
 * Parse an `important_files`-style value into a list of file paths. Tolerates a
 * JSON array, a JSON object map, or newline/comma-separated plain text.
 */
function parseFileList(value: unknown): string[] {
  const raw = str(value);
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return dedupeNonEmpty(parsed.map((p) => str(p) ?? ""));
    }
    if (parsed && typeof parsed === "object") {
      return dedupeNonEmpty(Object.keys(parsed as Record<string, unknown>));
    }
  } catch {
    // Not JSON; fall through to delimiter splitting.
  }
  return dedupeNonEmpty(raw.split(/[\r\n,]+/).map((p) => p.trim()));
}

/** De-duplicate, preserving order, dropping empties. */
function dedupeNonEmpty(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const v = item.trim();
    if (v.length > 0 && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Stable id from the identifying tuple of a memory. */
function memoryId(sessionId: string, kind: MemoryKind, sourceTable: string, sourceRef: string): string {
  return createHash("sha1")
    .update(`${sessionId}|${kind}|${sourceTable}|${sourceRef}`)
    .digest("hex")
    .slice(0, 32);
}

/** Join non-empty parts into a single content block. */
function joinContent(parts: Array<string | undefined>): string {
  return parts
    .map((p) => (p ? p.trim() : ""))
    .filter((p) => p.length > 0)
    .join("\n\n");
}

/** Best-effort `SELECT *` over a table; returns [] when the table is absent. */
function selectAll(db: SqliteDatabase, table: string): unknown[] {
  try {
    return db.prepare(`SELECT * FROM ${table}`).all();
  } catch {
    return [];
  }
}

/** Build the session-id -> parent metadata index. */
function buildParentIndex(rows: unknown[]): Map<string, ParentMeta> {
  const index = new Map<string, ParentMeta>();
  for (const raw of rows) {
    try {
      const row = raw as SessionRow;
      const id = str(row.id);
      if (!id) {
        continue;
      }
      index.set(id, {
        repository: str(row.repository),
        branch: str(row.branch),
        cwd: str(row.cwd),
        createdAt: toMillis(row.created_at),
        updatedAt: toMillis(row.updated_at),
      });
    } catch {
      // Skip a malformed session row; others still index.
    }
  }
  return index;
}

/** Emit the memories derived from a single checkpoint row. */
function memoriesFromCheckpoint(row: CheckpointRow, parents: Map<string, ParentMeta>): Memory[] {
  const sessionId = str(row.session_id);
  const sourceRef = str(row.id);
  if (!sessionId || !sourceRef) {
    return [];
  }
  const parent = parents.get(sessionId) ?? {};
  const createdAt = toMillis(row.created_at) || parent.createdAt || 0;
  const updatedAt = createdAt;
  const title = str(row.title);
  const overview = str(row.overview);
  const workDone = str(row.work_done);
  const technical = str(row.technical_details);

  const out: Memory[] = [];

  const base = {
    sessionId,
    repository: parent.repository,
    branch: parent.branch,
    cwd: parent.cwd,
    sourceTable: "checkpoints",
    sourceRef,
    createdAt,
    updatedAt,
  };

  // 1. decision (technical details present) or learning.
  const kind: MemoryKind = technical ? "decision" : "learning";
  const content = joinContent([overview, technical, workDone]);
  if (content.length > 0) {
    out.push({
      id: memoryId(sessionId, kind, "checkpoints", sourceRef),
      kind,
      title,
      content,
      ...base,
    });
  }

  // 2. todo from next_steps.
  const nextSteps = str(row.next_steps);
  if (nextSteps) {
    out.push({
      id: memoryId(sessionId, "todo", "checkpoints", sourceRef),
      kind: "todo",
      title,
      content: nextSteps,
      ...base,
    });
  }

  // 3. file_context from important_files.
  const files = parseFileList(row.important_files);
  if (files.length > 0) {
    out.push({
      id: memoryId(sessionId, "file_context", "checkpoints", sourceRef),
      kind: "file_context",
      title,
      content: files.join("\n"),
      ...base,
    });
  }

  return out;
}

/** Emit the summary memory derived from a single session row, if any. */
function memoryFromSession(row: SessionRow): Memory | undefined {
  const sessionId = str(row.id);
  const summary = str(row.summary);
  if (!sessionId || !summary) {
    return undefined;
  }
  const createdAt = toMillis(row.created_at);
  const updatedAt = toMillis(row.updated_at) || createdAt;
  return {
    id: memoryId(sessionId, "summary", "sessions", sessionId),
    sessionId,
    kind: "summary",
    content: summary,
    repository: str(row.repository),
    branch: str(row.branch),
    cwd: str(row.cwd),
    sourceTable: "sessions",
    sourceRef: sessionId,
    createdAt,
    updatedAt,
  };
}

/**
 * Extract every {@link Memory} from the Copilot session store. Returns an empty
 * array when the database is missing or unreadable.
 */
export function extractMemories(sourceDb: string = copilotSessionStoreDb): Memory[] {
  if (!fs.existsSync(sourceDb)) {
    return [];
  }

  let db: SqliteDatabase | undefined;
  const memories: Memory[] = [];
  try {
    db = openDatabase(sourceDb, { readOnly: true });

    const sessionRows = selectAll(db, "sessions");
    const parents = buildParentIndex(sessionRows);

    for (const raw of selectAll(db, "checkpoints")) {
      try {
        memories.push(...memoriesFromCheckpoint(raw as CheckpointRow, parents));
      } catch {
        // One bad checkpoint must not abort extraction.
      }
    }

    for (const raw of sessionRows) {
      try {
        const memory = memoryFromSession(raw as SessionRow);
        if (memory) {
          memories.push(memory);
        }
      } catch {
        // One bad session must not abort extraction.
      }
    }
  } catch {
    // Source unavailable/corrupt: return whatever was collected so far.
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures.
    }
  }

  return memories;
}
