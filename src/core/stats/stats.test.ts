import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeStats } from "./index.js";
import { openDatabase, type SqliteDatabase } from "../memory/sqlite.js";

/**
 * Fixtures mirror the real `session-store.db` shape: a handful of sessions
 * across two repositories, plus rows with NULL/empty repository (which must be
 * ignored by `topRepos`) and recent `updated_at` ISO timestamps (so they land
 * inside the trailing 30-day activity window).
 */
interface TempPaths {
  base: string;
  sourceDb: string;
}

function tempPaths(): TempPaths {
  const base = path.join(os.tmpdir(), `dcs-stats-${randomUUID()}`);
  fs.mkdirSync(base, { recursive: true });
  return { base, sourceDb: path.join(base, "session-store.db") };
}

/** A UTC `YYYY-MM-DD` string `daysAgo` days before now. */
function isoDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

const TODAY = isoDaysAgo(0);
const YESTERDAY = isoDaysAgo(1);
const THREE_DAYS_AGO = isoDaysAgo(3);

/** Build a minimal Copilot-shaped source database for stats tests. */
function buildSourceDb(file: string): void {
  const db: SqliteDatabase = openDatabase(file);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, branch TEXT,
      summary TEXT, created_at TEXT, updated_at TEXT, host_type TEXT
    );
  `);

  const insert = db.prepare(
    `INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at, host_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // octo/alpha: 3 sessions (the most), spread across three recent days.
  insert.run("a1", "C:/work/alpha", "octo/alpha", "main", "s", `${TODAY}T08:00:00Z`, `${TODAY}T09:00:00Z`, "cli");
  insert.run("a2", "C:/work/alpha", "octo/alpha", "feat", "s", `${YESTERDAY}T08:00:00Z`, `${YESTERDAY}T09:00:00Z`, "cli");
  insert.run("a3", "C:/work/alpha", "octo/alpha", "main", "s", `${THREE_DAYS_AGO}T08:00:00Z`, `${THREE_DAYS_AGO}T09:00:00Z`, "cli");

  // octo/beta: 2 sessions.
  insert.run("b1", "C:/work/beta", "octo/beta", "main", "s", `${TODAY}T10:00:00Z`, `${TODAY}T11:00:00Z`, "cli");
  insert.run("b2", "C:/work/beta", "octo/beta", "dev", "s", `${YESTERDAY}T10:00:00Z`, `${YESTERDAY}T11:00:00Z`, "cli");

  // NULL and empty repository rows must be ignored by topRepos but still count
  // toward totalSessions.
  insert.run("n1", "C:/work/none", null, null, "s", `${TODAY}T12:00:00Z`, `${TODAY}T13:00:00Z`, "cli");
  insert.run("n2", "C:/work/none", "   ", null, "s", `${YESTERDAY}T12:00:00Z`, `${YESTERDAY}T13:00:00Z`, "cli");

  db.close();
}

describe("computeStats", () => {
  let paths: TempPaths;

  beforeEach(() => {
    paths = tempPaths();
    buildSourceDb(paths.sourceDb);
  });

  afterEach(() => {
    fs.rmSync(paths.base, { recursive: true, force: true });
  });

  it("counts sessions and zeroes absent tables without throwing", () => {
    const report = computeStats(paths.sourceDb);
    expect(report.totalSessions).toBe(7);
    // The fixture has no checkpoints/turns tables: must be zero, not an error.
    expect(report.totalCheckpoints).toBe(0);
    expect(report.totalTurns).toBe(0);
    expect(typeof report.generatedAt).toBe("string");
    expect(report.generatedAt.length).toBeGreaterThan(0);
  });

  it("ranks top repositories by session count, ignoring NULL/empty", () => {
    const report = computeStats(paths.sourceDb);
    expect(report.topRepos).toEqual([
      { repository: "octo/alpha", sessions: 3 },
      { repository: "octo/beta", sessions: 2 },
    ]);
    // alpha (3) must sort before beta (2).
    expect(report.topRepos[0].sessions).toBeGreaterThanOrEqual(report.topRepos[1].sessions);
  });

  it("produces a filled 30-day activity window ordered oldest-first", () => {
    const report = computeStats(paths.sourceDb);
    const days = report.activityByDay;

    expect(days).toHaveLength(30);
    for (const day of days) {
      expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof day.sessions).toBe("number");
      expect(day.sessions).toBeGreaterThanOrEqual(0);
    }

    // Ascending, contiguous dates ending today.
    const dates = days.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
    expect(dates[dates.length - 1]).toBe(TODAY);

    // Counts land on the right day: 3 today (a1, b1, n1), 3 yesterday (a2, b2, n2).
    const byDate = new Map(days.map((d) => [d.date, d.sessions]));
    expect(byDate.get(TODAY)).toBe(3);
    expect(byDate.get(YESTERDAY)).toBe(3);
    expect(byDate.get(THREE_DAYS_AGO)).toBe(1);
  });

  it("returns a well-formed zeroed report when the source db is missing", () => {
    const report = computeStats(path.join(paths.base, "nope.db"));
    expect(report.totalSessions).toBe(0);
    expect(report.totalCheckpoints).toBe(0);
    expect(report.totalTurns).toBe(0);
    expect(report.topRepos).toEqual([]);
    expect(report.activityByDay).toHaveLength(30);
    expect(report.activityByDay.every((d) => d.sessions === 0)).toBe(true);
  });
});
