import { describe, it, expect } from "vitest";
import { runDoctor, aggregate } from "./index.js";
import type { DoctorCheck, DoctorDeps } from "./index.js";

/**
 * Deps that make every check pass. Individual tests override single fields to
 * exercise failure paths without touching the real wt/copilot/filesystem.
 */
function passingDeps(): DoctorDeps {
  return {
    resolve: (name) => `C:\\fake\\${name}.exe`,
    nodeVersion: "20.11.0",
    hasSqlite: () => true,
    ensureStateDirs: () => {},
    stateDir: "C:\\state",
    sessionStateDir: "C:\\copilot\\session-state",
    writeProbe: () => true,
    readProbe: () => true,
    tasksStatus: () => ({ snapshot: true, logon: true }),
  };
}

describe("aggregate", () => {
  it("is ok only when every check passes", () => {
    const checks: DoctorCheck[] = [
      { name: "a", ok: true, detail: "" },
      { name: "b", ok: true, detail: "" },
    ];
    expect(aggregate(checks).ok).toBe(true);
  });

  it("is not ok when any check fails", () => {
    const checks: DoctorCheck[] = [
      { name: "a", ok: true, detail: "" },
      { name: "b", ok: false, detail: "broken" },
    ];
    const result = aggregate(checks);
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(2);
  });

  it("treats an empty list as ok", () => {
    expect(aggregate([]).ok).toBe(true);
  });
});

describe("runDoctor", () => {
  it("passes all checks with fully-satisfied deps", () => {
    const result = runDoctor(passingDeps());
    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(8);
    for (const c of result.checks) {
      expect(c.ok).toBe(true);
      expect(c.detail.length).toBeGreaterThan(0);
    }
  });

  it("fails when wt.exe does not resolve and gives remediation detail", () => {
    const result = runDoctor({
      ...passingDeps(),
      resolve: (name) => (name === "wt" ? undefined : `C:\\fake\\${name}.exe`),
    });
    expect(result.ok).toBe(false);
    const wt = result.checks.find((c) => c.name.includes("wt.exe"));
    expect(wt?.ok).toBe(false);
    expect(wt?.detail).toMatch(/not found/i);
  });

  it("fails the Node check for an old version", () => {
    const result = runDoctor({ ...passingDeps(), nodeVersion: "18.19.0" });
    expect(result.ok).toBe(false);
    const node = result.checks.find((c) => c.name.startsWith("Node.js"));
    expect(node?.ok).toBe(false);
    expect(node?.detail).toMatch(/too old/i);
  });

  it("falls back to powershell when pwsh is absent", () => {
    const result = runDoctor({
      ...passingDeps(),
      resolve: (name) =>
        name === "pwsh" ? undefined : `C:\\fake\\${name}.exe`,
    });
    const shell = result.checks.find((c) => c.name === "PowerShell");
    expect(shell?.ok).toBe(true);
  });

  it("reports node:sqlite as a best-effort failure without crashing", () => {
    const result = runDoctor({ ...passingDeps(), hasSqlite: () => false });
    const sqlite = result.checks.find((c) => c.name === "node:sqlite");
    expect(sqlite?.ok).toBe(false);
    expect(sqlite?.detail).toMatch(/best-effort/i);
  });

  it("flags a non-writable state directory", () => {
    const result = runDoctor({ ...passingDeps(), writeProbe: () => false });
    const state = result.checks.find((c) => c.name.includes("State directory"));
    expect(state?.ok).toBe(false);
  });

  it("flags an unreadable Copilot session-state directory", () => {
    const result = runDoctor({ ...passingDeps(), readProbe: () => false });
    const session = result.checks.find((c) => c.name.includes("session-state"));
    expect(session?.ok).toBe(false);
  });

  it("flags missing scheduled tasks with remediation", () => {
    const result = runDoctor({
      ...passingDeps(),
      tasksStatus: () => ({ snapshot: true, logon: false }),
    });
    const tasks = result.checks.find((c) => c.name === "Scheduled tasks");
    expect(tasks?.ok).toBe(false);
    expect(tasks?.detail).toMatch(/install-tasks/);
  });

  it("handles a throwing tasksStatus gracefully", () => {
    const result = runDoctor({
      ...passingDeps(),
      tasksStatus: () => {
        throw new Error("schtasks blew up");
      },
    });
    const tasks = result.checks.find((c) => c.name === "Scheduled tasks");
    expect(tasks?.ok).toBe(false);
    expect(tasks?.detail).toMatch(/schtasks blew up/);
  });
});
