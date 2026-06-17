import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "./manager.js";
import { createRegistry } from "./registry/index.js";
import { defaultConfig } from "./config.js";
import type { DiscoveredSession, ResumeOptions, WindowSpec } from "./types.js";

function tmpDirs() {
  const base = path.join(os.tmpdir(), "dcs-mgr-" + randomUUID());
  return {
    managedDir: path.join(base, "m"),
    workspacesDir: path.join(base, "w"),
    snapshotsDir: path.join(base, "s"),
  };
}

const live: DiscoveredSession = {
  id: "aaa", cwd: "C:/repo/a", cwdExists: true, name: "Alpha",
  repository: "o/a", branch: "main", clientName: "github/cli",
  liveness: "live", livePids: [1], topLevel: true, updatedAt: "2026-01-02T00:00:00Z",
};
const idle: DiscoveredSession = {
  id: "bbb", cwd: "C:/repo/b", cwdExists: true, name: "Beta",
  repository: "o/b", liveness: "inactive", livePids: [], topLevel: true,
  updatedAt: "2026-01-01T00:00:00Z",
};
const subagent: DiscoveredSession = {
  id: "ccc", cwd: "C:/repo/a", cwdExists: true, name: "Sub", clientName: "task",
  liveness: "live", livePids: [1], topLevel: false, updatedAt: "2026-01-01T12:00:00Z",
};

function makeManager() {
  const registry = createRegistry(tmpDirs());
  const resumeCalls: ResumeOptions[] = [];
  const launchCalls: WindowSpec[][] = [];
  const mgr = new SessionManager({
    registry,
    config: { ...defaultConfig },
    discover: () => [live, idle, subagent],
    getSession: (id) => [live, idle, subagent].find((s) => s.id === id),
    resume: (opts) => {
      resumeCalls.push(opts);
      return { ok: true, tabsLaunched: 1, windowsOpened: 1, warnings: [] };
    },
    launchWindows: (windows) => {
      launchCalls.push(windows);
      return { ok: true, tabsLaunched: 99, windowsOpened: windows.length, warnings: [] };
    },
  });
  return { mgr, registry, resumeCalls, launchCalls };
}

describe("SessionManager", () => {
  it("filters live vs all", () => {
    const { mgr } = makeManager();
    expect(mgr.listSessions("live").map((s) => s.id).sort()).toEqual(["aaa", "ccc"]);
    expect(mgr.listSessions("all")).toHaveLength(3);
  });

  it("captureLayout includes only live top-level sessions, grouped by repo", () => {
    const { mgr } = makeManager();
    const windows = mgr.captureLayout("live");
    expect(windows).toHaveLength(1);
    expect(windows[0].tabs).toHaveLength(1);
    expect(windows[0].tabs[0].sessionId).toBe("aaa");
    expect(windows[0].tabs[0].title).toBe("Alpha");
  });

  it("updateManaged persists and merges into the view", () => {
    const { mgr } = makeManager();
    const view = mgr.updateManaged("aaa", { color: "#FF0000", title: "Renamed" });
    expect(view.managed).toBe(true);
    expect(view.color).toBe("#FF0000");
    const again = mgr.listSessions("all").find((s) => s.id === "aaa");
    expect(again?.color).toBe("#FF0000");
    expect(again?.title).toBe("Renamed");
  });

  it("createWorkspace fromLive captures and persists the layout", () => {
    const { mgr } = makeManager();
    const ws = mgr.createWorkspace({ name: "morning", fromLive: true, filter: "live" });
    expect(ws.name).toBe("morning");
    expect(ws.windows[0].tabs[0].sessionId).toBe("aaa");
    expect(mgr.listWorkspaces().map((w) => w.name)).toContain("morning");
  });

  it("snapshot writes a rolling snapshot of live sessions", () => {
    const { mgr } = makeManager();
    const snap = mgr.snapshot();
    expect(snap.source).toBe("auto-snapshot");
    expect(mgr.listSnapshots()).toHaveLength(1);
    expect(mgr.latestSnapshot()?.id).toBe(snap.id);
  });

  it("resume fills defaults from discovery", () => {
    const { mgr, resumeCalls } = makeManager();
    mgr.resume({ sessionId: "aaa" });
    expect(resumeCalls[0].cwd).toBe("C:/repo/a");
    expect(resumeCalls[0].title).toBe("Alpha");
  });

  it("restoreByNameOrId launches the saved workspace windows", () => {
    const { mgr, launchCalls } = makeManager();
    mgr.createWorkspace({ name: "layoutX", fromLive: true, filter: "live" });
    const result = mgr.restoreByNameOrId("layoutX");
    expect(result.ok).toBe(true);
    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0][0].tabs[0].sessionId).toBe("aaa");
  });

  it("restoreWorkspace reports an error for unknown id", () => {
    const { mgr } = makeManager();
    const result = mgr.restoreWorkspace("does-not-exist");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("updateManaged ignores a sessionId injected via the patch body", () => {
    const { mgr, registry } = makeManager();
    mgr.updateManaged("aaa", { color: "#111111", sessionId: "evil" } as never);
    expect(registry.getManaged("aaa")?.color).toBe("#111111");
    expect(registry.getManaged("evil")).toBeUndefined();
  });
});

describe("SessionManager open-session model", () => {
  it("dedupes co-located live sessions to one primary per PID", () => {
    const { mgr } = makeManager();
    const result = mgr.listSessionsResult("open");
    // aaa and ccc share pid 1; aaa is newer -> primary. bbb is inactive.
    expect(result.sessions.map((s) => s.id)).toEqual(["aaa"]);
    expect(result.openCount).toBe(1);
    const primary = result.sessions[0];
    expect(primary.role).toBe("primary");
    expect(primary.childCount).toBe(1);
  });

  it("live filter is flat and annotates role", () => {
    const { mgr } = makeManager();
    const live = mgr.listSessionsResult("live");
    expect(live.sessions.map((s) => s.id).sort()).toEqual(["aaa", "ccc"]);
    const ccc = live.sessions.find((s) => s.id === "ccc");
    expect(ccc?.role).toBe("child");
  });

  it("captureLayout captures one tab per open terminal (no children)", () => {
    const { mgr } = makeManager();
    const windows = mgr.captureLayout();
    expect(windows).toHaveLength(1);
    expect(windows[0].tabs.map((t) => t.sessionId)).toEqual(["aaa"]);
  });

  it("resume warns when the session is already open in a live terminal", () => {
    const { mgr } = makeManager();
    const result = mgr.resume({ sessionId: "aaa" });
    expect(result.warnings.some((w) => w.includes("already"))).toBe(true);
  });

  it("resumeMany launches one grouped window with all tabs", () => {
    const { mgr, launchCalls } = makeManager();
    const result = mgr.resumeMany(["aaa", "ccc"]);
    expect(result.ok).toBe(true);
    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0][0].tabs.map((t) => t.sessionId)).toEqual(["aaa", "ccc"]);
  });

  it("getSessionDetail returns the view plus co-located children", () => {
    const { mgr } = makeManager();
    const detail = mgr.getSessionDetail("aaa");
    expect(detail.session?.id).toBe("aaa");
    expect(detail.session?.role).toBe("primary");
    expect(detail.children.map((c) => c.id)).toEqual(["ccc"]);
    expect(mgr.getSessionDetail("does-not-exist").session).toBeNull();
  });
});
