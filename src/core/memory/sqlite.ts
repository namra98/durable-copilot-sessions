import { createRequire } from "node:module";

/**
 * Thin, shared access to Node's experimental built-in `node:sqlite` module for
 * the local memory layer. Centralizes the warning suppression so neither the
 * extractor (read-only source) nor the store (writable memory.db) ever prints
 * the "SQLite is an experimental feature" noise on a routine command.
 */

/** Minimal structural view of the `node:sqlite` surface the memory layer uses. */
export interface SqliteStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
}

export interface SqliteDatabase {
  prepare: (sql: string) => SqliteStatement;
  exec: (sql: string) => void;
  close: () => void;
}

export type SqliteDatabaseCtor = new (
  filename: string,
  options?: { readOnly?: boolean; open?: boolean },
) => SqliteDatabase;

/**
 * Run `fn` while suppressing only Node's experimental-SQLite warning. All other
 * warnings are forwarded unchanged. Mirrors the discovery layer's pattern so a
 * routine reindex/search never prints noise.
 */
export function suppressSqliteExperimentalWarning<T>(fn: () => T): T {
  const original = process.emitWarning.bind(process);
  const patched = (warning: string | Error, ...rest: unknown[]): void => {
    const message = typeof warning === "string" ? warning : warning.message;
    const mentionsExperimentalSqlite =
      /experimental/i.test(message) && /sqlite/i.test(message);
    const taggedExperimental = rest.some(
      (r) =>
        r === "ExperimentalWarning" ||
        (typeof r === "object" &&
          r !== null &&
          (r as { type?: unknown }).type === "ExperimentalWarning"),
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

let cachedCtor: SqliteDatabaseCtor | undefined;

/** Load the `DatabaseSync` constructor, or undefined when unavailable. */
export function loadDatabaseSync(): SqliteDatabaseCtor | undefined {
  if (cachedCtor) {
    return cachedCtor;
  }
  try {
    const req = createRequire(import.meta.url);
    cachedCtor = suppressSqliteExperimentalWarning(
      () => (req("node:sqlite") as { DatabaseSync?: SqliteDatabaseCtor }).DatabaseSync,
    );
  } catch {
    return undefined;
  }
  return cachedCtor;
}

/** Open a database (read-only when requested), suppressing the warning. */
export function openDatabase(
  filename: string,
  options?: { readOnly?: boolean },
): SqliteDatabase {
  const Ctor = loadDatabaseSync();
  if (!Ctor) {
    throw new Error("node:sqlite is unavailable in this Node runtime");
  }
  return suppressSqliteExperimentalWarning(() =>
    options ? new Ctor(filename, options) : new Ctor(filename),
  );
}
