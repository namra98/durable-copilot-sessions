import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemoryStore, extractMemories } from "./index.js";
import { openDatabase, type SqliteDatabase } from "./sqlite.js";

/**
 * The fixtures intentionally mirror the real `session-store.db` shape: two
 * sessions in the same repository (so `related` and `recall` have cross-session
 * data) and one in a different repository.
 */
interface TempPaths {
  base: string;
  sourceDb: string;
  memoryDb: string;
}

function tempPaths(): TempPaths {
  const base = path.join(os.tmpdir(), `dcs-memory-${randomUUID()}`);
  fs.mkdirSync(base, { recursive: true });
  return {
    base,
    sourceDb: path.join(base, "session-store.db"),
    memoryDb: path.join(base, "memory.db"),
  };
}

/** Build a minimal Copilot-shaped source database for extraction tests. */
function buildSourceDb(file: string): void {
  const db: SqliteDatabase = openDatabase(file);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, branch TEXT,
      summary TEXT, created_at INTEGER, updated_at INTEGER, host_type TEXT
    );
    CREATE TABLE checkpoints (
      id TEXT PRIMARY KEY, session_id TEXT, checkpoint_number INTEGER,
      title TEXT, overview TEXT, history TEXT, work_done TEXT,
      technical_details TEXT, important_files TEXT, next_steps TEXT,
      created_at INTEGER
    );
    CREATE TABLE session_files (
      id TEXT PRIMARY KEY, session_id TEXT, file_path TEXT,
      tool_name TEXT, turn_index INTEGER, first_seen_at INTEGER
    );
  `);

  const insertSession = db.prepare(
    `INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at, host_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertSession.run(
    "sess-a",
    "C:/work/alpha",
    "octo/alpha",
    "main",
    "Implemented the alpha login flow end to end.",
    1_700_000_000_000,
    1_700_000_100_000,
    "cli",
  );
  insertSession.run(
    "sess-b",
    "C:/work/alpha",
    "octo/alpha",
    "feature-x",
    "Refactored alpha config loader.",
    1_700_000_200_000,
    1_700_000_300_000,
    "cli",
  );
  insertSession.run(
    "sess-c",
    "C:/work/beta",
    "octo/beta",
    "main",
    "", // empty summary -> no summary memory
    1_700_000_400_000,
    1_700_000_500_000,
    "cli",
  );

  const insertCheckpoint = db.prepare(
    `INSERT INTO checkpoints
       (id, session_id, checkpoint_number, title, overview, history, work_done,
        technical_details, important_files, next_steps, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Decision: has technical_details with a distinctive keyword "bcrypt".
  insertCheckpoint.run(
    "cp-a1",
    "sess-a",
    1,
    "Auth checkpoint",
    "Built the login screen.",
    "",
    "Wired up the form and the handler.",
    "Chose bcrypt for password hashing with a cost factor of twelve.",
    JSON.stringify(["src/auth/login.ts", "src/auth/hash.ts"]),
    "Add logout and token refresh next.",
    1_700_000_050_000,
  );
  // Learning: no technical_details -> learning kind, no next_steps, no files.
  insertCheckpoint.run(
    "cp-b1",
    "sess-b",
    1,
    "Config checkpoint",
    "Learned the config loader merges env over file.",
    "",
    "Documented the precedence rules.",
    "",
    "",
    "",
    1_700_000_250_000,
  );

  const insertFile = db.prepare(
    `INSERT INTO session_files (id, session_id, file_path, tool_name, turn_index, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertFile.run("f1", "sess-a", "src/auth/login.ts", "edit", 1, 1_700_000_060_000);
  insertFile.run("f2", "sess-b", "src/config/loader.ts", "edit", 1, 1_700_000_260_000);

  db.close();
}

describe("memory extractor + store", () => {
  let paths: TempPaths;

  beforeEach(() => {
    paths = tempPaths();
    buildSourceDb(paths.sourceDb);
  });

  afterEach(() => {
    fs.rmSync(paths.base, { recursive: true, force: true });
  });

  it("extracts the expected memory counts and kinds", () => {
    const memories = extractMemories(paths.sourceDb);
    const kinds = memories.map((m) => m.kind).sort();

    // cp-a1 -> decision + todo + file_context; cp-b1 -> learning;
    // sess-a + sess-b summaries (sess-c summary is empty).
    expect(memories).toHaveLength(6);
    expect(kinds).toEqual(
      ["decision", "file_context", "learning", "summary", "summary", "todo"].sort(),
    );

    const decision = memories.find((m) => m.kind === "decision");
    expect(decision?.repository).toBe("octo/alpha");
    expect(decision?.branch).toBe("main");
    expect(decision?.sessionId).toBe("sess-a");
    expect(decision?.sourceTable).toBe("checkpoints");
    expect(decision?.content).toContain("bcrypt");

    // Stable ids: a second extraction produces identical ids.
    const again = extractMemories(paths.sourceDb);
    expect(again.map((m) => m.id).sort()).toEqual(memories.map((m) => m.id).sort());
  });

  it("reindexes idempotently", () => {
    const store = createMemoryStore(paths.memoryDb);
    try {
      const first = store.reindex(paths.sourceDb);
      expect(first.count).toBe(6);
      expect(store.count()).toBe(6);

      // Re-running must not duplicate rows.
      store.reindex(paths.sourceDb);
      expect(store.count()).toBe(6);
    } finally {
      store.close();
    }
  });

  it("searches and ranks a decision by a technical_details keyword", () => {
    const store = createMemoryStore(paths.memoryDb);
    try {
      store.reindex(paths.sourceDb);
      const hits = store.search("bcrypt");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].memory.kind).toBe("decision");
      expect(hits[0].memory.content).toContain("bcrypt");
      expect(hits[0].snippet).toContain("bcrypt");
      // Score is -bm25, so the top hit's score is the largest.
      for (const hit of hits.slice(1)) {
        expect(hits[0].score).toBeGreaterThanOrEqual(hit.score);
      }
    } finally {
      store.close();
    }
  });

  it("filters search by repository", () => {
    const store = createMemoryStore(paths.memoryDb);
    try {
      store.reindex(paths.sourceDb);
      const alpha = store.search("alpha", { repository: "octo/alpha" });
      expect(alpha.length).toBeGreaterThan(0);
      expect(alpha.every((h) => h.memory.repository === "octo/alpha")).toBe(true);

      const beta = store.search("alpha", { repository: "octo/beta" });
      expect(beta).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("returns recent memories for an empty query", () => {
    const store = createMemoryStore(paths.memoryDb);
    try {
      store.reindex(paths.sourceDb);
      const hits = store.search("   ", { repository: "octo/alpha" });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.memory.repository === "octo/alpha")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("finds cross-session same-repository memories via related()", () => {
    const store = createMemoryStore(paths.memoryDb);
    try {
      store.reindex(paths.sourceDb);
      const related = store.related("sess-a");
      expect(related.length).toBeGreaterThan(0);
      // Only other sessions in the same repo (octo/alpha) -> sess-b.
      expect(related.every((m) => m.sessionId === "sess-b")).toBe(true);
      expect(related.every((m) => m.repository === "octo/alpha")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("builds a recall pack with decisions, todos, summaries, and files", () => {
    const store = createMemoryStore(paths.memoryDb);
    try {
      store.reindex(paths.sourceDb);
      const pack = store.recall({ repository: "octo/alpha" });
      expect(pack.repository).toBe("octo/alpha");
      expect(pack.decisions.length).toBe(1);
      expect(pack.decisions[0].content).toContain("bcrypt");
      expect(pack.todos.length).toBe(1);
      expect(pack.todos[0].content).toContain("logout");
      expect(pack.summaries.length).toBe(2);
      expect(pack.files).toContain("src/auth/login.ts");
      expect(pack.files).toContain("src/auth/hash.ts");
      // De-duplicated file list.
      expect(new Set(pack.files).size).toBe(pack.files.length);
    } finally {
      store.close();
    }
  });

  it("scopes recall by branch", () => {
    const store = createMemoryStore(paths.memoryDb);
    try {
      store.reindex(paths.sourceDb);
      const pack = store.recall({ repository: "octo/alpha", branch: "main" });
      expect(pack.summaries.every((m) => m.branch === "main")).toBe(true);
      expect(pack.decisions.every((m) => m.branch === "main")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("lists memories for a single session", () => {
    const store = createMemoryStore(paths.memoryDb);
    try {
      store.reindex(paths.sourceDb);
      const list = store.listForSession("sess-a");
      expect(list.length).toBe(4); // decision + todo + file_context + summary
      expect(list.every((m) => m.sessionId === "sess-a")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("does not throw on FTS queries with quotes and special characters", () => {
    const store = createMemoryStore(paths.memoryDb);
    try {
      store.reindex(paths.sourceDb);
      const nasty = ['"', 'bcrypt"', 'a AND b', 'foo* OR bar', '"); DROP TABLE memories;--', '()'];
      for (const q of nasty) {
        expect(() => store.search(q)).not.toThrow();
      }
      // The table is intact after the injection-looking query.
      expect(store.count()).toBe(6);
    } finally {
      store.close();
    }
  });

  it("returns an empty array when the source db is missing", () => {
    expect(extractMemories(path.join(paths.base, "nope.db"))).toEqual([]);
  });
});
