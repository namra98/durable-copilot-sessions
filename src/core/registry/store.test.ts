import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRegistry, type Registry } from "./index.js";
import type { WindowSpec, Workspace } from "../types.js";

interface TempDirs {
  base: string;
  managedDir: string;
  workspacesDir: string;
  snapshotsDir: string;
}

function tempDirs(): TempDirs {
  const base = path.join(os.tmpdir(), `dcs-registry-${randomUUID()}`);
  return {
    base,
    managedDir: path.join(base, "sessions"),
    workspacesDir: path.join(base, "workspaces"),
    snapshotsDir: path.join(base, "snapshots"),
  };
}

function makeWorkspace(createdAt: string, name: string): Workspace {
  return {
    id: randomUUID(),
    name,
    source: "auto-snapshot",
    createdAt,
    updatedAt: createdAt,
    windows: [],
  };
}

describe("registry store", () => {
  let dirs: TempDirs;
  let reg: Registry;

  beforeEach(() => {
    dirs = tempDirs();
    reg = createRegistry({
      managedDir: dirs.managedDir,
      workspacesDir: dirs.workspacesDir,
      snapshotsDir: dirs.snapshotsDir,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dirs.base, { recursive: true, force: true });
  });

  it("creates every state directory on construction", () => {
    expect(fs.existsSync(dirs.managedDir)).toBe(true);
    expect(fs.existsSync(dirs.workspacesDir)).toBe(true);
    expect(fs.existsSync(dirs.snapshotsDir)).toBe(true);
  });

  it("upserts, gets, lists, and deletes managed sessions", () => {
    expect(reg.getManaged("s1")).toBeUndefined();
    expect(reg.listManaged()).toEqual([]);

    const created = reg.upsertManaged({ sessionId: "s1", title: "Hello" });
    expect(created.sessionId).toBe("s1");
    expect(created.title).toBe("Hello");
    expect(typeof created.updatedAt).toBe("string");

    expect(reg.getManaged("s1")).toEqual(created);
    expect(reg.listManaged()).toEqual([created]);

    reg.deleteManaged("s1");
    expect(reg.getManaged("s1")).toBeUndefined();
    expect(reg.listManaged()).toEqual([]);
  });

  it("merges patches and bumps updatedAt on managed update", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const first = reg.upsertManaged({
      sessionId: "s1",
      title: "First",
      pinned: true,
    });
    expect(first.updatedAt).toBe("2024-01-01T00:00:00.000Z");

    vi.setSystemTime(new Date("2024-01-01T00:05:00.000Z"));
    const second = reg.upsertManaged({ sessionId: "s1", color: "red" });

    expect(second.title).toBe("First"); // preserved from prior record
    expect(second.pinned).toBe(true); // preserved from prior record
    expect(second.color).toBe("red"); // newly applied
    expect(second.updatedAt).toBe("2024-01-01T00:05:00.000Z");
    expect(second.updatedAt).not.toBe(first.updatedAt);

    expect(reg.getManaged("s1")).toEqual(second);
  });

  it("creates, gets, saves, finds, lists, and deletes workspaces", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const ws = reg.createWorkspace({
      name: "morning",
      description: "layout",
      source: "manual",
      windows: [],
    });
    expect(ws.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ws.source).toBe("manual");
    expect(ws.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(ws.updatedAt).toBe("2024-01-01T00:00:00.000Z");

    expect(reg.getWorkspace(ws.id)).toEqual(ws);
    expect(reg.findWorkspaceByName("morning")?.id).toBe(ws.id);
    expect(reg.findWorkspaceByName("missing")).toBeUndefined();

    vi.setSystemTime(new Date("2024-01-01T01:00:00.000Z"));
    const saved = reg.saveWorkspace({ ...ws, name: "renamed" });
    expect(saved.id).toBe(ws.id);
    expect(saved.name).toBe("renamed");
    expect(saved.updatedAt).toBe("2024-01-01T01:00:00.000Z");
    expect(reg.listWorkspaces()).toHaveLength(1); // upsert by id, not a copy
    expect(reg.getWorkspace(ws.id)?.name).toBe("renamed");

    reg.deleteWorkspace(ws.id);
    expect(reg.getWorkspace(ws.id)).toBeUndefined();
    expect(reg.listWorkspaces()).toEqual([]);
  });

  it("lists workspaces sorted by updatedAt descending", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const a = reg.createWorkspace({ name: "a", source: "manual", windows: [] });
    vi.setSystemTime(new Date("2024-01-02T00:00:00.000Z"));
    const b = reg.createWorkspace({ name: "b", source: "manual", windows: [] });
    vi.setSystemTime(new Date("2024-01-03T00:00:00.000Z"));
    const c = reg.createWorkspace({ name: "c", source: "manual", windows: [] });

    expect(reg.listWorkspaces().map((w) => w.id)).toEqual([a.id, b.id, c.id].reverse());
  });

  it("round-trips a workspace with nested windows and tabs", () => {
    const windows: WindowSpec[] = [
      {
        id: "win-1",
        label: "Repo A",
        tabs: [
          {
            sessionId: "sess-a",
            title: "A",
            color: "blue",
            cwd: "C:\\repos\\a",
            copilotArgs: ["--allow-all-tools"],
          },
          {
            sessionId: "sess-b",
            title: "B",
            color: "#FF0000",
            cwd: "C:\\repos\\b",
          },
        ],
      },
      {
        id: "win-2",
        tabs: [
          { sessionId: "sess-c", title: "C", color: "green", cwd: "C:\\repos\\c" },
        ],
      },
    ];
    const ws = reg.createWorkspace({
      name: "nested",
      description: "deep",
      source: "imported",
      windows,
    });

    // In-memory round-trip via getWorkspace.
    expect(reg.getWorkspace(ws.id)).toEqual(ws);

    // The written file parses back equal (atomic-write integrity proxy).
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dirs.workspacesDir, `${ws.id}.json`), "utf8"),
    ) as Workspace;
    expect(onDisk).toEqual(ws);
  });

  it("adds snapshots, retaining only the newest N, newest-first", () => {
    const retain = 3;
    for (let i = 0; i < 5; i++) {
      const ts = `2024-01-0${i + 1}T00:00:00.000Z`;
      reg.addSnapshot(makeWorkspace(ts, `snap-${i}`), retain);
    }

    const snaps = reg.listSnapshots();
    expect(snaps).toHaveLength(retain);
    expect(snaps.map((s) => s.name)).toEqual(["snap-4", "snap-3", "snap-2"]);
    expect(reg.latestSnapshot()?.name).toBe("snap-4");
  });

  it("round-trips a single snapshot", () => {
    const ws = makeWorkspace("2024-05-01T12:30:45.678Z", "solo");
    const returned = reg.addSnapshot(ws, 10);
    expect(returned).toEqual(ws);
    expect(reg.listSnapshots()).toEqual([ws]);
    expect(reg.latestSnapshot()).toEqual(ws);
  });

  it("skips corrupt JSON files across all stores without throwing", () => {
    reg.upsertManaged({ sessionId: "ok" });
    fs.writeFileSync(
      path.join(dirs.managedDir, "corrupt.json"),
      "{ not json",
      "utf8",
    );
    expect(() => reg.listManaged()).not.toThrow();
    expect(reg.listManaged().map((m) => m.sessionId)).toEqual(["ok"]);

    const good = reg.createWorkspace({
      name: "good",
      source: "manual",
      windows: [],
    });
    fs.writeFileSync(path.join(dirs.workspacesDir, "corrupt.json"), "}}}", "utf8");
    expect(reg.listWorkspaces().map((w) => w.id)).toEqual([good.id]);

    reg.addSnapshot(makeWorkspace("2024-06-01T00:00:00.000Z", "snap-ok"), 10);
    // A far-future filename would sort first; the corrupt body must be skipped.
    fs.writeFileSync(
      path.join(dirs.snapshotsDir, "2999-01-01T00-00-00-000Z-zzz.json"),
      "not json",
      "utf8",
    );
    expect(reg.listSnapshots().map((s) => s.name)).toEqual(["snap-ok"]);
    expect(reg.latestSnapshot()?.name).toBe("snap-ok");
  });

  it("tolerates missing directories on read", () => {
    const fresh = tempDirs();
    const r = createRegistry({
      managedDir: fresh.managedDir,
      workspacesDir: fresh.workspacesDir,
      snapshotsDir: fresh.snapshotsDir,
    });
    // Remove the just-created dirs to simulate a never-written store.
    fs.rmSync(fresh.base, { recursive: true, force: true });

    expect(r.listManaged()).toEqual([]);
    expect(r.listWorkspaces()).toEqual([]);
    expect(r.listSnapshots()).toEqual([]);
    expect(r.getManaged("x")).toBeUndefined();
    expect(r.getWorkspace("x")).toBeUndefined();
    expect(r.latestSnapshot()).toBeUndefined();
  });
});

describe("id safety (review fix)", () => {
  it("rejects path-traversal ids on read/delete and throws on unsafe write", () => {
    const dirs = tempDirs();
    const r = createRegistry(dirs);
    expect(r.getWorkspace("../../evil")).toBeUndefined();
    expect(r.getManaged("..\\..\\evil")).toBeUndefined();
    expect(() => r.deleteWorkspace("../../evil")).not.toThrow();
    expect(() => r.upsertManaged({ sessionId: "../../evil", color: "#fff" })).toThrow();
    fs.rmSync(dirs.base, { recursive: true, force: true });
  });
});
