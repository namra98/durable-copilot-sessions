import fs from "node:fs";
import path from "node:path";

import type { Memory, MemoryKind, MemoryRecallPack, MemorySearchHit } from "../types.js";
import { memoryDb } from "../paths.js";
import { extractMemories } from "./extractor.js";
import { openDatabase, type SqliteDatabase } from "./sqlite.js";

/**
 * Local, private memory store backed by a writable SQLite database
 * (`memory.db`, separate from Copilot's). Holds extracted {@link Memory}
 * records plus an FTS5 index for ranked recall. No network, no API keys — a
 * fully local recall layer.
 */

/** Public surface of a memory store instance. */
export interface MemoryStore {
  /** Re-extract from the source store and upsert every memory. Idempotent. */
  reindex: (sourceDb?: string) => { count: number };
  /** Ranked full-text search with optional repository/kind filters. */
  search: (
    query: string,
    opts?: { repository?: string; kind?: MemoryKind; limit?: number },
  ) => MemorySearchHit[];
  /** Memories from other sessions sharing this session's repository. */
  related: (sessionId: string, opts?: { limit?: number }) => Memory[];
  /** Context pack (decisions/todos/summaries/files) for a repo/branch. */
  recall: (opts: { repository?: string; branch?: string; limit?: number }) => MemoryRecallPack;
  /** All memories for one session, oldest first. */
  listForSession: (sessionId: string) => Memory[];
  /** Total number of stored memories. */
  count: () => number;
  /** Close the underlying database handle. */
  close: () => void;
}

/** Raw memories row as read back from SQLite. */
interface MemoryRow {
  id: string;
  session_id: string;
  kind: string;
  title: string | null;
  content: string;
  repository: string | null;
  branch: string | null;
  cwd: string | null;
  source_table: string;
  source_ref: string | null;
  created_at: number;
  updated_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  kind TEXT,
  title TEXT,
  content TEXT,
  repository TEXT,
  branch TEXT,
  cwd TEXT,
  source_table TEXT,
  source_ref TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_repo ON memories(repository);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title,
  content,
  content='memories',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO memories_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;
`;

/** Map a raw SQLite row to a domain {@link Memory}. */
function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind as MemoryKind,
    title: row.title ?? undefined,
    content: row.content,
    repository: row.repository ?? undefined,
    branch: row.branch ?? undefined,
    cwd: row.cwd ?? undefined,
    sourceTable: row.source_table,
    sourceRef: row.source_ref ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Turn arbitrary user input into a safe FTS5 MATCH expression. Each whitespace
 * token is treated as a quoted string literal (so operators like `*`, `:`, `-`
 * or stray quotes can't alter or break the query). Tokens with no alphanumeric
 * content are dropped. Returns undefined when nothing searchable remains.
 */
function sanitizeFtsQuery(query: string): string | undefined {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  if (tokens.length === 0) {
    return undefined;
  }
  return tokens.join(" ");
}

/** Create (or open) a local memory store at `dbPath`. */
export function createMemoryStore(dbPath: string = memoryDb): MemoryStore {
  const dir = path.dirname(dbPath);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db: SqliteDatabase = openDatabase(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(SCHEMA);

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO memories
       (id, session_id, kind, title, content, repository, branch, cwd,
        source_table, source_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  function reindex(sourceDb?: string): { count: number } {
    const memories = extractMemories(sourceDb);
    db.exec("BEGIN");
    try {
      for (const m of memories) {
        upsert.run(
          m.id,
          m.sessionId,
          m.kind,
          m.title ?? null,
          m.content,
          m.repository ?? null,
          m.branch ?? null,
          m.cwd ?? null,
          m.sourceTable,
          m.sourceRef ?? null,
          m.createdAt,
          m.updatedAt,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    // Guarantee the FTS index matches the content table even if a prior run
    // left it inconsistent.
    try {
      db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
    } catch {
      // Rebuild is a safety net; triggers already keep FTS in sync.
    }
    return { count: memories.length };
  }

  function recentFiltered(opts?: {
    repository?: string;
    kind?: MemoryKind;
    limit?: number;
  }): MemorySearchHit[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts?.repository) {
      clauses.push("repository = ?");
      params.push(opts.repository);
    }
    if (opts?.kind) {
      clauses.push("kind = ?");
      params.push(opts.kind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = opts?.limit ?? 20;
    const rows = db
      .prepare(`SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit) as MemoryRow[];
    return rows.map((row) => ({ memory: rowToMemory(row), score: 0 }));
  }

  function search(
    query: string,
    opts?: { repository?: string; kind?: MemoryKind; limit?: number },
  ): MemorySearchHit[] {
    const match = sanitizeFtsQuery(query ?? "");
    if (!match) {
      return recentFiltered(opts);
    }

    const clauses = ["memories_fts MATCH ?"];
    const params: unknown[] = [match];
    if (opts?.repository) {
      clauses.push("m.repository = ?");
      params.push(opts.repository);
    }
    if (opts?.kind) {
      clauses.push("m.kind = ?");
      params.push(opts.kind);
    }
    const limit = opts?.limit ?? 20;

    const sql = `
      SELECT m.*, bm25(memories_fts) AS bm,
             snippet(memories_fts, 1, '[', ']', '…', 12) AS snip
      FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE ${clauses.join(" AND ")}
      ORDER BY bm25(memories_fts)
      LIMIT ?`;

    let rows: Array<MemoryRow & { bm: number; snip: string | null }>;
    try {
      rows = db.prepare(sql).all(...params, limit) as Array<
        MemoryRow & { bm: number; snip: string | null }
      >;
    } catch {
      // A pathological MATCH should degrade gracefully, not throw.
      return recentFiltered(opts);
    }

    return rows.map((row) => ({
      memory: rowToMemory(row),
      score: -row.bm,
      snippet: row.snip ?? undefined,
    }));
  }

  function related(sessionId: string, opts?: { limit?: number }): Memory[] {
    const repoRows = db
      .prepare(
        "SELECT DISTINCT repository FROM memories WHERE session_id = ? AND repository IS NOT NULL",
      )
      .all(sessionId) as Array<{ repository: string }>;
    const repos = repoRows.map((r) => r.repository).filter((r) => r.length > 0);
    if (repos.length === 0) {
      return [];
    }
    const limit = opts?.limit ?? 20;
    const placeholders = repos.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT * FROM memories
         WHERE session_id != ? AND repository IN (${placeholders})
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(sessionId, ...repos, limit) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  function recallByKind(
    kind: MemoryKind,
    repository: string | undefined,
    branch: string | undefined,
    limit: number,
  ): Memory[] {
    const clauses = ["kind = ?"];
    const params: unknown[] = [kind];
    if (repository) {
      clauses.push("repository = ?");
      params.push(repository);
    }
    if (branch) {
      clauses.push("branch = ?");
      params.push(branch);
    }
    const rows = db
      .prepare(
        `SELECT * FROM memories WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params, limit) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  function recall(opts: {
    repository?: string;
    branch?: string;
    limit?: number;
  }): MemoryRecallPack {
    const cap = opts.limit ?? 10;
    const decisions = recallByKind("decision", opts.repository, opts.branch, cap);
    const todos = recallByKind("todo", opts.repository, opts.branch, cap);
    const summaries = recallByKind("summary", opts.repository, opts.branch, cap);

    const fileMemories = recallByKind("file_context", opts.repository, opts.branch, cap * 2);
    const seen = new Set<string>();
    const files: string[] = [];
    for (const mem of fileMemories) {
      for (const line of mem.content.split(/\r?\n/)) {
        const file = line.trim();
        if (file.length > 0 && !seen.has(file)) {
          seen.add(file);
          files.push(file);
        }
      }
    }

    return {
      repository: opts.repository,
      branch: opts.branch,
      decisions,
      todos,
      summaries,
      files,
    };
  }

  function listForSession(sessionId: string): Memory[] {
    const rows = db
      .prepare("SELECT * FROM memories WHERE session_id = ? ORDER BY created_at ASC, id ASC")
      .all(sessionId) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  function count(): number {
    const row = db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
    return row.n;
  }

  function close(): void {
    try {
      db.close();
    } catch {
      // Ignore close failures.
    }
  }

  return { reindex, search, related, recall, listForSession, count, close };
}
