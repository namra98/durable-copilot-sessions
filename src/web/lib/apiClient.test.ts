import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportWorkspaces,
  getConfig,
  getGraph,
  getSessionDetail,
  getStale,
  getStats,
  importWorkspaces,
  listSessions,
  listSnapshots,
  patchSession,
  putConfig,
  resumeBatch,
  searchMemory,
} from "./apiClient";

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeTextResponse(text: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    json: () => Promise.reject(new Error("not json")),
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("listSessions calls /api/sessions?filter=open and parses { sessions, openCount }", async () => {
    const sessions = [
      {
        id: "abc-123",
        cwd: "C:\\work\\repo",
        cwdExists: true,
        liveness: "live",
        livePids: [42],
        topLevel: true,
        managed: false,
        role: "primary",
        groupPid: 42,
        childCount: 2,
      },
    ];
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse({ sessions, openCount: 7 })),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await listSessions("open");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/sessions?filter=open");
    expect(result.sessions).toEqual(sessions);
    expect(result.openCount).toBe(7);
  });

  it("listSessions falls back to sessions.length when openCount is absent", async () => {
    const sessions = [
      { id: "a", cwd: "x", cwdExists: true, liveness: "live", livePids: [], topLevel: true, managed: false },
      { id: "b", cwd: "y", cwdExists: true, liveness: "stale", livePids: [], topLevel: true, managed: false },
    ];
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse({ sessions })),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await listSessions("live");
    expect(result.openCount).toBe(2);
  });

  it("resumeBatch POSTs the session ids and window to /api/sessions/resume-batch", async () => {
    const launch = { ok: true, tabsLaunched: 3, windowsOpened: 1, warnings: [] };
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse(launch)),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await resumeBatch(["a", "b", "c"], "new");

    expect(mockFetch.mock.calls[0][0]).toBe("/api/sessions/resume-batch");
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ sessionIds: ["a", "b", "c"], window: "new" });
    expect(result).toEqual(launch);
  });

  it("throws with the server error message on a non-2xx response", async () => {
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse({ error: "session not found" }, false, 404)),
    );
    vi.stubGlobal("fetch", mockFetch);

    await expect(patchSession("missing", { title: "x" })).rejects.toThrow("session not found");
  });

  it("getGraph calls /api/graph?filter=open and returns the model", async () => {
    const model = {
      nodes: [
        {
          id: "n1",
          label: "alpha",
          cwd: "C:\\work\\a",
          liveness: "live",
          isFork: false,
          childCount: 0,
        },
      ],
      edges: [{ id: "e1", source: "n1", target: "n2", kind: "fork" }],
      openCount: 3,
    };
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse(model)),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await getGraph("open");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/graph?filter=open");
    expect(result).toEqual(model);
  });

  it("searchMemory builds the query string and unwraps { hits }", async () => {
    const hits = [
      {
        memory: {
          id: "m1",
          sessionId: "s1",
          kind: "decision",
          content: "use JWT",
          sourceTable: "checkpoints",
          createdAt: 1,
          updatedAt: 2,
        },
        score: 0.9,
        snippet: "use JWT",
      },
    ];
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse({ hits })),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await searchMemory({ q: "jwt auth", kind: "decision", repository: "o/r", limit: 10 });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url.startsWith("/api/memory/search?")).toBe(true);
    expect(url).toContain("q=jwt+auth");
    expect(url).toContain("kind=decision");
    expect(url).toContain("repository=o%2Fr");
    expect(url).toContain("limit=10");
    expect(result).toEqual(hits);
  });

  it("getSessionDetail calls /api/sessions/:id and returns { session, children }", async () => {
    const session = {
      id: "abc-123",
      cwd: "C:\\work\\repo",
      cwdExists: true,
      liveness: "live",
      livePids: [42],
      topLevel: true,
      managed: false,
      role: "primary",
      groupPid: 42,
      childCount: 1,
    };
    const children = [
      {
        id: "child-1",
        cwd: "C:\\work\\repo",
        cwdExists: true,
        liveness: "live",
        livePids: [99],
        topLevel: false,
        managed: false,
        role: "child",
        groupPid: 42,
      },
    ];
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse({ session, children })),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await getSessionDetail("abc-123");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/sessions/abc-123");
    expect(result.session).toEqual(session);
    expect(result.children).toEqual(children);
  });

  it("getSessionDetail defaults children to [] when the field is absent", async () => {
    const session = {
      id: "solo",
      cwd: "x",
      cwdExists: false,
      liveness: "inactive",
      livePids: [],
      topLevel: true,
      managed: false,
    };
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse({ session })),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await getSessionDetail("solo");
    expect(result.children).toEqual([]);
  });

  it("getStats calls /api/stats and returns the roll-up", async () => {
    const stats = {
      totalSessions: 12,
      totalCheckpoints: 4,
      totalTurns: 88,
      topRepos: [{ repository: "o/r", sessions: 6 }],
      activityByDay: [{ date: "2024-01-01", sessions: 3 }],
      generatedAt: "2024-01-02T00:00:00.000Z",
    };
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse(stats)),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await getStats();
    expect(mockFetch.mock.calls[0][0]).toBe("/api/stats");
    expect(result).toEqual(stats);
  });

  it("getConfig unwraps { config } from /api/config", async () => {
    const config = { apiPort: 4123, webPort: 5173, colorStrategy: "by-repo" };
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse({ config })),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await getConfig();
    expect(mockFetch.mock.calls[0][0]).toBe("/api/config");
    expect(result).toEqual(config);
  });

  it("putConfig PUTs a partial config and unwraps the result", async () => {
    const config = { apiPort: 4123, webPort: 5173, autoOpenBrowser: false };
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse({ config })),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await putConfig({ autoOpenBrowser: false });
    expect(mockFetch.mock.calls[0][0]).toBe("/api/config");
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ autoOpenBrowser: false });
    expect(result).toEqual(config);
  });

  it("listSnapshots unwraps { snapshots } from /api/snapshots", async () => {
    const snapshots = [{ id: "snap-1", name: "auto", source: "auto-snapshot", windows: [] }];
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse({ snapshots })),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await listSnapshots();
    expect(mockFetch.mock.calls[0][0]).toBe("/api/snapshots");
    expect(result).toEqual(snapshots);
  });

  it("exportWorkspaces returns the raw JSON text and forwards ids", async () => {
    const json = '{"workspaces":[]}';
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeTextResponse(json)),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await exportWorkspaces(["a", "b"]);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/workspaces/export?ids=a%2Cb");
    expect(result).toBe(json);
  });

  it("importWorkspaces POSTs { json, freshIds } and unwraps { workspaces }", async () => {
    const workspaces = [{ id: "w1", name: "imported", source: "imported", windows: [] }];
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse({ workspaces })),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await importWorkspaces('{"workspaces":[]}', true);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/workspaces/import");
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ json: '{"workspaces":[]}', freshIds: true });
    expect(result).toEqual(workspaces);
  });

  it("getStale unwraps { sessions } from /api/sessions/stale", async () => {
    const sessions = [
      { id: "dead-1", cwd: "x", cwdExists: true, liveness: "stale", livePids: [], topLevel: true, managed: false },
    ];
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse({ sessions })),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await getStale();
    expect(mockFetch.mock.calls[0][0]).toBe("/api/sessions/stale");
    expect(result).toEqual(sessions);
  });
});
