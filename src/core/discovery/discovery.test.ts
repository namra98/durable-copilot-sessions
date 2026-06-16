import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { stringify } from "yaml";
import { listSessions, getSession, isPidAlive, enrichSummaries } from "./discovery.js";
import type { DiscoveredSession } from "../types.js";

/** The current process is, by definition, alive — use it for the live lock. */
const LIVE_PID = process.pid;
/** Absurdly large pid that is not a running process on any realistic machine. */
const DEAD_PID = 999999999;

const LIVE_ID = "11111111-1111-1111-1111-111111111111";
const STALE_ID = "22222222-2222-2222-2222-222222222222";
const INACTIVE_ID = "33333333-3333-3333-3333-333333333333";
const SUBAGENT_ID = "44444444-4444-4444-4444-444444444444";
const NO_CLIENT_ID = "55555555-5555-5555-5555-555555555555";
const NO_UPDATED_ID = "66666666-6666-6666-6666-666666666666";

let stateDir: string;
/** A store-db path that does not exist, so enrichment is a hermetic no-op. */
let missingStoreDb: string;

function writeSession(id: string, data: Record<string, unknown>, lockPids: number[] = []): void {
  const dir = path.join(stateDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "workspace.yaml"), stringify(data), "utf8");
  for (const pid of lockPids) {
    fs.writeFileSync(path.join(dir, `inuse.${pid}.lock`), "", "utf8");
  }
}

function list(overrides: Record<string, unknown> = {}): DiscoveredSession[] {
  return listSessions({ sessionStateDir: stateDir, sessionStoreDb: missingStoreDb, ...overrides });
}

function byId(sessions: DiscoveredSession[]): Record<string, DiscoveredSession> {
  return Object.fromEntries(sessions.map((session) => [session.id, session]));
}

function sqliteAvailable(): boolean {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-discovery-test-"));
  missingStoreDb = path.join(stateDir, "no-such-session-store.db");

  // Live: full fields, top-level CLI client, current process holds the lock.
  writeSession(
    LIVE_ID,
    {
      id: LIVE_ID,
      cwd: stateDir,
      git_root: stateDir,
      repository: "owner/repo",
      branch: "main",
      client_name: "github/cli",
      name: "My Live Session",
      user_named: true,
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-06-01T00:00:00.000Z",
    },
    [LIVE_PID],
  );

  // Stale: only a dead lock; cwd points at a non-existent path.
  writeSession(
    STALE_ID,
    {
      id: STALE_ID,
      cwd: path.join(stateDir, "does-not-exist"),
      repository: "owner/stale",
      branch: "feature",
      client_name: "github/cli",
      name: "Stale Session",
      updated_at: "2024-05-01T00:00:00.000Z",
    },
    [DEAD_PID],
  );

  // Inactive: no lock files at all; newest updatedAt among non-live sessions.
  writeSession(INACTIVE_ID, {
    id: INACTIVE_ID,
    cwd: stateDir,
    client_name: "github/cli",
    name: "Inactive Session",
    updated_at: "2024-12-01T00:00:00.000Z",
  });

  // Subagent: a non-CLI client => not top-level.
  writeSession(SUBAGENT_ID, {
    id: SUBAGENT_ID,
    cwd: stateDir,
    client_name: "task",
    name: "Subagent Session",
    updated_at: "2024-03-01T00:00:00.000Z",
  });

  // No client_name => treated as top-level.
  writeSession(NO_CLIENT_ID, {
    id: NO_CLIENT_ID,
    cwd: stateDir,
    name: "No Client Session",
    updated_at: "2024-02-01T00:00:00.000Z",
  });

  // No updated_at => must sort last among non-live sessions.
  writeSession(NO_UPDATED_ID, {
    id: NO_UPDATED_ID,
    cwd: stateDir,
    name: "No Timestamp Session",
  });

  // A stray folder lacking workspace.yaml must be ignored entirely.
  fs.mkdirSync(path.join(stateDir, "not-a-session"), { recursive: true });
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("listSessions", () => {
  it("parses core workspace.yaml fields", () => {
    const full = byId(list())[LIVE_ID];
    expect(full).toBeDefined();
    expect(full.name).toBe("My Live Session");
    expect(full.cwd).toBe(stateDir);
    expect(full.cwdExists).toBe(true);
    expect(full.repository).toBe("owner/repo");
    expect(full.branch).toBe("main");
    expect(full.gitRoot).toBe(stateDir);
    expect(full.clientName).toBe("github/cli");
    expect(full.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(full.updatedAt).toBe("2024-06-01T00:00:00.000Z");
  });

  it("reports cwdExists=false for a missing cwd", () => {
    expect(byId(list())[STALE_ID].cwdExists).toBe(false);
  });

  it("skips folders without a workspace.yaml", () => {
    const sessions = list();
    expect(sessions.some((session) => session.id === "not-a-session")).toBe(false);
    expect(sessions).toHaveLength(6);
  });

  it("classifies liveness from inuse.*.lock files and pid liveness", () => {
    const sessions = byId(list());
    expect(sessions[LIVE_ID].liveness).toBe("live");
    expect(sessions[LIVE_ID].livePids).toContain(LIVE_PID);
    expect(sessions[STALE_ID].liveness).toBe("stale");
    expect(sessions[STALE_ID].livePids).toEqual([]);
    expect(sessions[INACTIVE_ID].liveness).toBe("inactive");
    expect(sessions[INACTIVE_ID].livePids).toEqual([]);
  });

  it("flags topLevel for github/cli and undefined client, but not subagents", () => {
    const sessions = byId(list());
    expect(sessions[LIVE_ID].topLevel).toBe(true);
    expect(sessions[NO_CLIENT_ID].topLevel).toBe(true);
    expect(sessions[SUBAGENT_ID].topLevel).toBe(false);
    expect(sessions[SUBAGENT_ID].clientName).toBe("task");
  });

  it("sorts live first, then by updatedAt descending with missing last", () => {
    const order = list().map((session) => session.id);
    expect(order[0]).toBe(LIVE_ID);
    expect(order.slice(1)).toEqual([
      INACTIVE_ID, // 2024-12
      STALE_ID, // 2024-05
      SUBAGENT_ID, // 2024-03
      NO_CLIENT_ID, // 2024-02
      NO_UPDATED_ID, // missing => last
    ]);
  });

  it("returns an empty array for a non-existent state dir", () => {
    expect(list({ sessionStateDir: path.join(stateDir, "nope") })).toEqual([]);
  });
});

describe("getSession", () => {
  it("returns the matching session", () => {
    const session = getSession(SUBAGENT_ID, {
      sessionStateDir: stateDir,
      sessionStoreDb: missingStoreDb,
    });
    expect(session?.id).toBe(SUBAGENT_ID);
    expect(session?.name).toBe("Subagent Session");
  });

  it("returns undefined for an unknown id", () => {
    const session = getSession("does-not-exist", {
      sessionStateDir: stateDir,
      sessionStoreDb: missingStoreDb,
    });
    expect(session).toBeUndefined();
  });
});

describe("isPidAlive", () => {
  it("is true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("is false for a pid that is not running", () => {
    expect(isPidAlive(DEAD_PID)).toBe(false);
  });

  it("rejects non-positive and non-integer pids", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
  });
});

describe("enrichSummaries", () => {
  it("does nothing when the store db is missing", () => {
    const sessions = list();
    expect(sessions.every((session) => session.summary === undefined)).toBe(true);
  });

  it.skipIf(!sqliteAvailable())("attaches summaries from the sqlite index", () => {
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req("node:sqlite") as {
      DatabaseSync: new (filename: string) => {
        exec: (sql: string) => void;
        prepare: (sql: string) => { run: (...params: unknown[]) => void };
        close: () => void;
      };
    };
    const dbPath = path.join(stateDir, "session-store.db");
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE sessions (id TEXT, cwd TEXT, repository TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT, host_type TEXT)",
    );
    db.prepare("INSERT INTO sessions (id, summary) VALUES (?, ?)").run(LIVE_ID, "live summary");
    db.close();

    try {
      const sessions = list({ sessionStoreDb: dbPath });
      expect(byId(sessions)[LIVE_ID].summary).toBe("live summary");
      // Sessions absent from the index keep an undefined summary.
      expect(byId(sessions)[STALE_ID].summary).toBeUndefined();

      // The standalone helper sets summaries in place too.
      const manual: DiscoveredSession[] = [
        {
          id: LIVE_ID,
          cwd: stateDir,
          cwdExists: true,
          liveness: "inactive",
          livePids: [],
          topLevel: true,
        },
      ];
      enrichSummaries(manual, dbPath);
      expect(manual[0].summary).toBe("live summary");
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });
});
