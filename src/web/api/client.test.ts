import { afterEach, describe, expect, it, vi } from "vitest";
import { listSessions, patchSession } from "./client";

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
  it("listSessions calls /api/sessions?filter=live and parses { sessions }", async () => {
    const sessions = [
      {
        id: "abc-123",
        cwd: "C:\\work\\repo",
        cwdExists: true,
        liveness: "live",
        livePids: [42],
        topLevel: true,
        managed: false,
      },
    ];
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse({ sessions })),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await listSessions("live");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/sessions?filter=live");
    expect(result).toEqual(sessions);
  });

  it("throws with the server error message on a non-2xx response", async () => {
    const mockFetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(makeResponse({ error: "session not found" }, false, 404)),
    );
    vi.stubGlobal("fetch", mockFetch);

    await expect(patchSession("missing", { title: "x" })).rejects.toThrow("session not found");
  });
});
