import fs from "node:fs";
import path from "node:path";
import { logsDir } from "../paths.js";

/**
 * Read-side utilities for the durable JSON-lines logs written by logger.ts.
 * Logs live in `logsDir` as one file per day named `api-YYYY-MM-DD.log`, with
 * one JSON record per line (fields: ts, level, message, scope, ...).
 */

export interface LogRecord {
  ts?: string;
  level?: string;
  message?: string;
  scope?: string;
  [k: string]: unknown;
}

export interface TailOptions {
  dir?: string;
  lines?: number;
  level?: string;
}

const levelRank: Record<string, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const FILE_RE = /^api-(\d{4}-\d{2}-\d{2})\.log$/;

interface LogFile {
  date: string;
  path: string;
}

/** List `api-YYYY-MM-DD.log` files in `dir`, newest date first. */
function listLogFiles(dir: string): LogFile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files: LogFile[] = [];
  for (const name of entries) {
    const m = FILE_RE.exec(name);
    if (m) {
      files.push({ date: m[1]!, path: path.join(dir, name) });
    }
  }
  files.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return files;
}

/** Parse every JSON line in `file`, skipping blank or unparseable lines. */
function parseFile(file: string): LogRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records: LogRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed as LogRecord);
      }
    } catch {
      // Skip unparseable lines.
    }
  }
  return records;
}

function passesLevel(record: LogRecord, minRank: number): boolean {
  const level = typeof record.level === "string" ? record.level.toLowerCase() : "";
  const rank = levelRank[level];
  if (rank === undefined) {
    return false;
  }
  return rank >= minRank;
}

/**
 * Read the most recent `api-*.log` file(s) in `dir` (default `logsDir`), parse
 * JSON lines (skipping unparseable ones), optionally filter by minimum `level`
 * severity, and return the last `lines` records (default 200), newest last.
 * Reads across the latest 1-2 day files if needed to fill `lines`.
 */
export function tailLogs(opts: TailOptions = {}): LogRecord[] {
  const dir = opts.dir ?? logsDir;
  const lines = opts.lines ?? 200;
  const minRank =
    opts.level !== undefined ? levelRank[opts.level.toLowerCase()] : undefined;

  if (lines <= 0) {
    return [];
  }

  const files = listLogFiles(dir);
  if (files.length === 0) {
    return [];
  }

  // Collect from newest file backward, across at most 2 day files.
  const collected: LogRecord[][] = [];
  let total = 0;
  for (const file of files) {
    if (collected.length >= 2) {
      break;
    }
    const records = parseFile(file.path);
    collected.push(records);
    total += records.length;
    if (total >= lines) {
      break;
    }
  }

  // collected is newest-first; flatten to oldest-first so newest ends up last.
  collected.reverse();
  let all: LogRecord[] = [];
  for (const records of collected) {
    all = all.concat(records);
  }

  if (minRank !== undefined) {
    all = all.filter((r) => passesLevel(r, minRank));
  }

  return all.slice(-lines);
}

/**
 * Delete `api-YYYY-MM-DD.log` files whose date is older than `retainDays` days.
 * Returns the count of files removed. Never throws.
 */
export function pruneLogs(retainDays: number, dir?: string): { removed: number } {
  const targetDir = dir ?? logsDir;
  let removed = 0;
  const files = listLogFiles(targetDir);
  if (files.length === 0) {
    return { removed };
  }

  const now = new Date();
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const cutoff = todayUtc - retainDays * 24 * 60 * 60 * 1000;

  for (const file of files) {
    const fileUtc = Date.parse(file.date + "T00:00:00Z");
    if (Number.isNaN(fileUtc)) {
      continue;
    }
    if (fileUtc < cutoff) {
      try {
        fs.rmSync(file.path);
        removed += 1;
      } catch {
        // Pruning must never throw; ignore filesystem failures.
      }
    }
  }

  return { removed };
}

/** Return the available `YYYY-MM-DD` log dates in `dir`, newest first. */
export function listLogDays(dir?: string): string[] {
  return listLogFiles(dir ?? logsDir).map((f) => f.date);
}
