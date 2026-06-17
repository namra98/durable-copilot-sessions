import fs from "node:fs";

import { copilotSessionStoreDb } from "../paths.js";
import { openDatabase, type SqliteDatabase } from "../memory/sqlite.js";

/**
 * Read-only, defensive statistics over Copilot's `session-store.db`. No writes,
 * no network — a deterministic roll-up of session counts, top repositories, and
 * recent daily activity.
 *
 * The source database is opened read-only; this module never mutates it. Every
 * query is wrapped so a missing table or column yields zeros instead of an
 * exception, mirroring the extractor's tolerance of an evolving schema.
 */

/** Aggregate, read-only view of the Copilot session store. */
export interface StatsReport {
  totalSessions: number;
  totalCheckpoints: number;
  totalTurns: number;
  topRepos: Array<{ repository: string; sessions: number }>;
  activityByDay: Array<{ date: string; sessions: number }>;
  generatedAt: string;
}

/** Number of trailing days (including today) covered by `activityByDay`. */
const ACTIVITY_WINDOW_DAYS = 30;

/** Maximum number of repositories reported by `topRepos`. */
const TOP_REPOS_LIMIT = 15;

/** Coerce a `COUNT(*)` result to a finite, non-negative integer. */
function asCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 ? Math.trunc(value) : 0;
  }
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  }
  return 0;
}

/** Coerce a scalar to a trimmed non-empty string, else undefined. */
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

/** Convert epoch seconds or milliseconds to a UTC `YYYY-MM-DD` string. */
function epochToIsoDate(value: number): string | undefined {
  const ms = value < 1e12 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

/**
 * Coerce a stored `updated_at` to a `YYYY-MM-DD` day key. Accepts ISO strings
 * (taking the leading date), numeric epochs (seconds or millis), and numeric
 * strings. Returns undefined when unparseable so the row is simply skipped.
 */
function toIsoDate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return epochToIsoDate(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const isoPrefix = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
    if (isoPrefix) {
      return isoPrefix[1];
    }
    if (/^\d+$/.test(trimmed)) {
      const asNum = Number(trimmed);
      if (Number.isFinite(asNum)) {
        return epochToIsoDate(asNum);
      }
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString().slice(0, 10);
    }
  }
  return undefined;
}

/** Best-effort `COUNT(*)` over a table; returns 0 when the table is absent. */
function countTable(db: SqliteDatabase, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: unknown };
    return asCount(row?.n);
  } catch {
    return 0;
  }
}

/** Top repositories by session count, ignoring NULL/empty repository values. */
function topRepositories(db: SqliteDatabase): Array<{ repository: string; sessions: number }> {
  try {
    const rows = db
      .prepare(
        `SELECT repository AS repository, COUNT(*) AS sessions
           FROM sessions
          WHERE repository IS NOT NULL AND TRIM(repository) <> ''
          GROUP BY repository
          ORDER BY sessions DESC, repository ASC
          LIMIT ${TOP_REPOS_LIMIT}`,
      )
      .all();
    const out: Array<{ repository: string; sessions: number }> = [];
    for (const raw of rows) {
      const row = raw as { repository?: unknown; sessions?: unknown };
      const repository = str(row.repository);
      const sessions = asCount(row.sessions);
      if (repository && sessions > 0) {
        out.push({ repository, sessions });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Build the trailing-window day buckets ending at `endIsoDate` (inclusive),
 * filling any day with no sessions as 0. Days are ordered oldest-first.
 */
function buildActivityWindow(
  counts: Map<string, number>,
  endIsoDate: string,
): Array<{ date: string; sessions: number }> {
  const out: Array<{ date: string; sessions: number }> = [];
  const end = new Date(`${endIsoDate}T00:00:00.000Z`);
  const endTime = end.getTime();
  const base = Number.isNaN(endTime) ? new Date() : new Date(endTime);
  for (let offset = ACTIVITY_WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
    const day = new Date(base);
    day.setUTCDate(day.getUTCDate() - offset);
    const date = day.toISOString().slice(0, 10);
    out.push({ date, sessions: counts.get(date) ?? 0 });
  }
  return out;
}

/** Sessions grouped by `updated_at` day across the trailing activity window. */
function activityByDay(
  db: SqliteDatabase,
  endIsoDate: string,
): Array<{ date: string; sessions: number }> {
  const counts = new Map<string, number>();
  try {
    const rows = db.prepare(`SELECT updated_at AS updated_at FROM sessions`).all();
    for (const raw of rows) {
      const row = raw as { updated_at?: unknown };
      const date = toIsoDate(row.updated_at);
      if (date) {
        counts.set(date, (counts.get(date) ?? 0) + 1);
      }
    }
  } catch {
    // Missing table/column: fall through to an all-zero window.
  }
  return buildActivityWindow(counts, endIsoDate);
}

/**
 * Compute a read-only {@link StatsReport} from the Copilot session store.
 * Returns zeroed counts and empty lists (still with a filled activity window)
 * when the database is missing or unreadable; never throws on a partial schema.
 */
export function computeStats(sourceDb: string = copilotSessionStoreDb): StatsReport {
  const generatedAt = new Date().toISOString();
  const endIsoDate = generatedAt.slice(0, 10);

  const empty: StatsReport = {
    totalSessions: 0,
    totalCheckpoints: 0,
    totalTurns: 0,
    topRepos: [],
    activityByDay: buildActivityWindow(new Map<string, number>(), endIsoDate),
    generatedAt,
  };

  if (!fs.existsSync(sourceDb)) {
    return empty;
  }

  let db: SqliteDatabase | undefined;
  try {
    db = openDatabase(sourceDb, { readOnly: true });
    return {
      totalSessions: countTable(db, "sessions"),
      totalCheckpoints: countTable(db, "checkpoints"),
      totalTurns: countTable(db, "turns"),
      topRepos: topRepositories(db),
      activityByDay: activityByDay(db, endIsoDate),
      generatedAt,
    };
  } catch {
    // Source unavailable/corrupt: report a well-formed, zeroed result.
    return empty;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures.
    }
  }
}
