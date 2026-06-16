import { afterEach, describe, expect, it, vi } from "vitest";
import { getGraph, listSessions, patchSession, resumeBatch, searchMemory } from "./client";

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
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
});
