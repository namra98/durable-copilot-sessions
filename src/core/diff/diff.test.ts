import { describe, it, expect } from "vitest";
import { diffWorkspace } from "./diff.js";
import type { DiscoveredSession, TabSpec, Workspace } from "../types.js";

function tab(sessionId: string, title: string, cwd: string): TabSpec {
  return { sessionId, title, color: "blue", cwd };
}

function session(
  id: string,
  cwd: string,
  overrides: Partial<DiscoveredSession> = {},
): DiscoveredSession {
  return {
    id,
    cwd,
    cwdExists: true,
    liveness: "live",
    livePids: [],
    topLevel: true,
    ...overrides,
  };
}

function workspace(windows: Workspace["windows"]): Workspace {
  return {
    id: "ws-1",
    name: "test-layout",
    source: "manual",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    windows,
  };
}

describe("diffWorkspace", () => {
  it("classifies missing, staleCwd, addedLive, and unchanged across windows", () => {
    const ws = workspace([
      {
        id: "w1",
        tabs: [
          tab("clean", "Clean Tab", "C:/repo/a"),
          tab("gone", "Gone Tab", "C:/repo/b"),
        ],
      },
      {
        id: "w2",
        tabs: [tab("stale", "Stale Tab", "C:/repo/c")],
      },
    ]);

    const live: DiscoveredSession[] = [
      session("clean", "C:/repo/a"),
      // "gone" intentionally absent -> missing
      session("stale", "C:/repo/c", { cwdExists: false }),
      session("extra", "C:/repo/d", { name: "Extra Live" }),
    ];

    const diff = diffWorkspace(ws, live);

    expect(diff.missing.map((e) => e.sessionId)).toEqual(["gone"]);
    expect(diff.missing[0].detail).toBe("session no longer discovered");

    expect(diff.staleCwd.map((e) => e.sessionId)).toEqual(["stale"]);
    expect(diff.staleCwd[0].title).toBe("Stale Tab");

    expect(diff.addedLive.map((e) => e.sessionId)).toEqual(["extra"]);
    expect(diff.addedLive[0].title).toBe("Extra Live");
    expect(diff.addedLive[0].detail).toBe("live but not in workspace");

    expect(diff.unchanged).toBe(1);
    expect(diff.changed).toEqual([]);
  });

  it("flags a differing cwd as staleCwd even when cwd still exists", () => {
    const ws = workspace([{ id: "w1", tabs: [tab("moved", "Moved", "C:/old/path")] }]);
    const live = [session("moved", "C:/new/path")];

    const diff = diffWorkspace(ws, live);

    expect(diff.staleCwd.map((e) => e.sessionId)).toEqual(["moved"]);
    expect(diff.staleCwd[0].detail).toContain("C:/new/path");
    expect(diff.unchanged).toBe(0);
  });

  it("treats path-separator and trailing-slash differences as unchanged", () => {
    const ws = workspace([{ id: "w1", tabs: [tab("p", "P", "C:\\repo\\a\\")] }]);
    const live = [session("p", "C:/repo/a")];

    expect(diffWorkspace(ws, live).unchanged).toBe(1);
  });

  it("reports a conservative branch change only when the title encodes a branch", () => {
    const ws = workspace([{ id: "w1", tabs: [tab("b", "feature @main", "C:/repo/a")] }]);
    const live = [session("b", "C:/repo/a", { branch: "develop" })];

    const diff = diffWorkspace(ws, live);

    expect(diff.changed.map((e) => e.sessionId)).toEqual(["b"]);
    expect(diff.changed[0].detail).toContain("develop");
    expect(diff.unchanged).toBe(0);
  });

  it("does not flag a branch change when the title carries no branch token", () => {
    const ws = workspace([{ id: "w1", tabs: [tab("b", "Plain Title", "C:/repo/a")] }]);
    const live = [session("b", "C:/repo/a", { branch: "develop" })];

    const diff = diffWorkspace(ws, live);

    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });
});
