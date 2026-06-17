import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tailLogs, pruneLogs, listLogDays } from "./logs.js";

function tmpDir(): string {
  return path.join(os.tmpdir(), "dcs-logs-" + randomUUID());
}

function writeLog(dir: string, date: string, lines: string[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `api-${date}.log`), lines.join("\n") + "\n", "utf8");
}

function rec(level: string, message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: `2026-06-01T00:00:00Z`, level, message, scope: "test", ...extra });
}

describe("tailLogs", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns parsed records newest-last and skips unparseable lines", () => {
    writeLog(dir, "2026-06-02", [
      rec("info", "one"),
      "this is not json {",
      rec("warn", "two"),
      rec("error", "three"),
    ]);

    const out = tailLogs({ dir });
    expect(out.map((r) => r.message)).toEqual(["one", "two", "three"]);
    expect(out.every((r) => r.scope === "test")).toBe(true);
  });

  it("respects the lines limit, keeping the newest", () => {
    writeLog(dir, "2026-06-02", [
      rec("info", "a"),
      rec("info", "b"),
      rec("info", "c"),
      rec("info", "d"),
    ]);

    const out = tailLogs({ dir, lines: 2 });
    expect(out.map((r) => r.message)).toEqual(["c", "d"]);
  });

  it("filters by minimum level severity", () => {
    writeLog(dir, "2026-06-02", [
      rec("debug", "d"),
      rec("info", "i"),
      rec("warn", "w"),
      rec("error", "e"),
    ]);

    const out = tailLogs({ dir, level: "warn" });
    expect(out.map((r) => r.message)).toEqual(["w", "e"]);
  });

  it("reads across the latest two day files to fill lines, newest last", () => {
    writeLog(dir, "2026-06-01", [rec("info", "old1"), rec("info", "old2")]);
    writeLog(dir, "2026-06-02", [rec("info", "new1"), rec("info", "new2")]);

    const out = tailLogs({ dir, lines: 4 });
    expect(out.map((r) => r.message)).toEqual(["old1", "old2", "new1", "new2"]);
  });

  it("returns [] for a missing directory", () => {
    expect(tailLogs({ dir: path.join(dir, "does-not-exist") })).toEqual([]);
  });
});

describe("pruneLogs", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function dayOffset(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  it("removes only files older than retainDays", () => {
    const recent = dayOffset(-1);
    const old = dayOffset(-10);
    writeLog(dir, recent, [rec("info", "recent")]);
    writeLog(dir, old, [rec("info", "old")]);

    const result = pruneLogs(7, dir);
    expect(result.removed).toBe(1);
    expect(fs.existsSync(path.join(dir, `api-${recent}.log`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `api-${old}.log`))).toBe(false);
  });

  it("never throws on a missing directory", () => {
    expect(() => pruneLogs(7, path.join(dir, "nope"))).not.toThrow();
    expect(pruneLogs(7, path.join(dir, "nope")).removed).toBe(0);
  });
});

describe("listLogDays", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists available log dates newest first", () => {
    writeLog(dir, "2026-06-01", [rec("info", "a")]);
    writeLog(dir, "2026-06-03", [rec("info", "b")]);
    writeLog(dir, "2026-06-02", [rec("info", "c")]);

    expect(listLogDays(dir)).toEqual(["2026-06-03", "2026-06-02", "2026-06-01"]);
  });

  it("returns [] for a missing directory", () => {
    expect(listLogDays(path.join(dir, "missing"))).toEqual([]);
  });
});
