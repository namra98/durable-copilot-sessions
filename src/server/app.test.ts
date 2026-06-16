import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import type { SessionManager } from "../core/manager.js";

/** A minimal fake SessionManager exposing only what the routes call. */
function makeFakeManager(): SessionManager {
  const fake = {
    listSessions: (filter: string) => [
      { id: "s1", cwd: "C:/x", cwdExists: true, liveness: "live", livePids: [1], topLevel: true, managed: false, _filter: filter },
    ],
    updateManaged: (id: string, patch: Record<string, unknown>) => ({
      id,
      cwd: "C:/x",
      cwdExists: true,
      liveness: "inactive",
      livePids: [],
      topLevel: true,
      managed: true,
      ...patch,
    }),
    resume: (opts: Record<string, unknown>) => ({
      ok: true,
      tabsLaunched: 1,
      windowsOpened: 1,
      warnings: [],
      _sessionId: opts.sessionId,
    }),
    listWorkspaces: () => [{ id: "w1", name: "demo", source: "manual", createdAt: "", updatedAt: "", windows: [] }],
    getWorkspace: (id: string) =>
      id === "w1" ? { id: "w1", name: "demo", source: "manual", createdAt: "", updatedAt: "", windows: [] } : undefined,
    createWorkspace: (input: Record<string, unknown>) => ({
      id: "w2",
      name: input.name,
      source: "manual",
      createdAt: "",
      updatedAt: "",
      windows: [],
    }),
    deleteWorkspace: () => undefined,
    restoreWorkspace: () => ({ ok: true, tabsLaunched: 2, windowsOpened: 1, warnings: [] }),
    snapshot: () => ({ id: "snap1", name: "autosnapshot", source: "auto-snapshot", createdAt: "", updatedAt: "", windows: [] }),
    listSnapshots: () => [],
    getConfig: () => ({
      apiPort: 4517,
      webPort: 4516,
      snapshotIntervalMinutes: 5,
      maxAutoSnapshots: 50,
      colorStrategy: "by-repo",
      autoOpenBrowser: true,
      windowGrouping: "by-repo",
    }),
  };
  return fake as unknown as SessionManager;
}

describe("server API", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = createApp(makeFakeManager());
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /api/health returns ok", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
  });

  it("GET /api/sessions returns sessions array", async () => {
    const res = await fetch(`${base}/api/sessions?filter=live`);
    const body = (await res.json()) as { sessions: Array<{ id: string }> };
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions[0].id).toBe("s1");
  });

  it("POST /api/sessions/:id/resume returns a LaunchResult", async () => {
    const res = await fetch(`${base}/api/sessions/abc/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ window: "new" }),
    });
    const body = (await res.json()) as { ok: boolean; tabsLaunched: number };
    expect(body.ok).toBe(true);
    expect(body.tabsLaunched).toBe(1);
  });

  it("POST /api/workspaces requires a name", async () => {
    const res = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/workspaces creates a workspace", async () => {
    const res = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo", fromLive: true }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: { name: string } };
    expect(body.workspace.name).toBe("demo");
  });

  it("GET /api/workspaces/:id 404s for unknown id", async () => {
    const res = await fetch(`${base}/api/workspaces/nope`);
    expect(res.status).toBe(404);
  });
});
