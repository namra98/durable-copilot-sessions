import fs from "node:fs";
import path from "node:path";
import { logsDir, ensureStateDirs } from "./paths.js";

/**
 * Minimal durable JSON-lines logger. Writes one structured record per line to
 * ~/.durable-copilot-sessions/state/logs/api-YYYY-MM-DD.log and mirrors to the
 * console. The file is the durable record; console output is convenience.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function activeLevel(): LogLevel {
  const env = (process.env.DCS_LOG_LEVEL ?? "info").toLowerCase();
  if (env === "debug" || env === "info" || env === "warn" || env === "error") {
    return env;
  }
  return "info";
}

function currentLogFile(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(logsDir, `api-${day}.log`);
}

export interface LogFields {
  scope?: string;
  sessionId?: string;
  [key: string]: unknown;
}

function write(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (levelRank[level] < levelRank[activeLevel()]) {
    return;
  }
  const record = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(record);
  try {
    ensureStateDirs();
    fs.appendFileSync(currentLogFile(), line + "\n", "utf8");
  } catch {
    // Logging must never throw; ignore filesystem failures.
  }
  const consoleFn =
    level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleFn(line);
}

export const log = {
  debug: (message: string, fields?: LogFields) => write("debug", message, fields),
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields),
};
