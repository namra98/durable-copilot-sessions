import { describe, expect, it } from "vitest";
import type { SessionView } from "../api/client";
import {
  applyQuickFilters,
  childrenOf,
  deriveSessionBuckets,
  displayName,
  groupByRepo,
  groupKeyFor,
  searchSessions,
  sortSessions,
} from "./sessions";

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    id: "id-0000",
    cwd: "C:\\work\\repo",
    cwdExists: true,
    liveness: "live",
    livePids: [],
    topLevel: true,
    managed: false,
    ...over,
  };
}

describe("deriveSessionBuckets", () => {
  it("derives open and live views from one all-sessions result", () => {
    const primary = session({ id: "primary", role: "primary", livePids: [1] });
    const child = session({ id: "child", role: "child", livePids: [1] });
    const stale = session({ id: "stale", liveness: "stale" });

    const buckets = deriveSessionBuckets({
      sessions: [primary, child, stale],
      openCount: 1,
    });

    expect(buckets.open.map((s) => s.id)).toEqual(["primary"]);
    expect(buckets.live.map((s) => s.id)).toEqual(["primary", "child"]);
    expect(buckets.all.map((s) => s.id)).toEqual(["primary", "child", "stale"]);
    expect(buckets.openCount).toBe(1);
  });
});

describe("displayName", () => {
  it("prefers title, then name, then the id head", () => {
    expect(displayName(session({ title: "T", name: "N" }))).toBe("T");
    expect(displayName(session({ title: "  ", name: "N" }))).toBe("N");
    expect(displayName(session({ id: "abcd-ef" }))).toBe("abcd");
  });
});

describe("searchSessions", () => {
  const list = [
    session({ id: "a", name: "alpha", repository: "octo/api", branch: "main", cwd: "C:\\a" }),
    session({ id: "b", name: "beta", repository: "octo/web", branch: "dev", cwd: "C:\\b", summary: "fix login" }),
  ];

  it("returns all when the query is empty", () => {
    expect(searchSessions(list, "  ")).toHaveLength(2);
  });

  it("matches case-insensitively across fields", () => {
    expect(searchSessions(list, "WEB").map((s) => s.id)).toEqual(["b"]);
    expect(searchSessions(list, "login").map((s) => s.id)).toEqual(["b"]);
  });

  it("requires every token to match (AND)", () => {
    expect(searchSessions(list, "octo dev").map((s) => s.id)).toEqual(["b"]);
    expect(searchSessions(list, "octo nope")).toHaveLength(0);
  });
});

describe("applyQuickFilters", () => {
  const list = [
    session({ id: "ok", cwdExists: true, childCount: 0 }),
    session({ id: "missing", cwdExists: false, childCount: 3 }),
  ];

  it("returns all with no chips", () => {
    expect(applyQuickFilters(list, [])).toHaveLength(2);
  });

  it("filters missing-cwd", () => {
    expect(applyQuickFilters(list, ["missing-cwd"]).map((s) => s.id)).toEqual(["missing"]);
  });

  it("filters has-children", () => {
    expect(applyQuickFilters(list, ["has-children"]).map((s) => s.id)).toEqual(["missing"]);
  });
});

describe("sortSessions", () => {
  it("floats pinned sessions to the top regardless of key", () => {
    const list = [
      session({ id: "old", updatedAt: "2020-01-01T00:00:00Z" }),
      session({ id: "pin", updatedAt: "2019-01-01T00:00:00Z", pinned: true }),
    ];
    expect(sortSessions(list, "recent").map((s) => s.id)).toEqual(["pin", "old"]);
  });

  it("sorts by recent activity (newest first)", () => {
    const list = [
      session({ id: "old", updatedAt: "2020-01-01T00:00:00Z" }),
      session({ id: "new", updatedAt: "2024-01-01T00:00:00Z" }),
    ];
    expect(sortSessions(list, "recent").map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("sorts by name and by liveness", () => {
    const byName = sortSessions(
      [session({ id: "1", name: "zeta" }), session({ id: "2", name: "alpha" })],
      "name",
    );
    expect(byName.map((s) => s.name)).toEqual(["alpha", "zeta"]);

    const byLive = sortSessions(
      [session({ id: "1", liveness: "inactive" }), session({ id: "2", liveness: "live" })],
      "liveness",
    );
    expect(byLive.map((s) => s.id)).toEqual(["2", "1"]);
  });

  it("does not mutate the input array", () => {
    const list = [session({ id: "a" }), session({ id: "b" })];
    const copy = [...list];
    sortSessions(list, "name");
    expect(list).toEqual(copy);
  });
});

describe("groupByRepo", () => {
  it("groups by repository then gitRoot then cwd, sorted by label", () => {
    const list = [
      session({ id: "1", repository: "octo/web" }),
      session({ id: "2", repository: "octo/api" }),
      session({ id: "3", repository: "octo/web" }),
      session({ id: "4", repository: undefined, gitRoot: "C:\\zzz" }),
    ];
    const groups = groupByRepo(list);
    expect(groups.map((g) => g.label)).toEqual(["C:\\zzz", "octo/api", "octo/web"]);
    expect(groups.find((g) => g.key === "octo/web")?.sessions).toHaveLength(2);
  });

  it("groupKeyFor falls back through repository, gitRoot, cwd", () => {
    expect(groupKeyFor(session({ repository: "r" }))).toBe("r");
    expect(groupKeyFor(session({ repository: undefined, gitRoot: "g" }))).toBe("g");
    expect(groupKeyFor(session({ repository: undefined, gitRoot: undefined, cwd: "c" }))).toBe("c");
  });
});

describe("childrenOf", () => {
  it("returns live siblings sharing the primary's groupPid, excluding itself", () => {
    const primary = session({ id: "p", role: "primary", groupPid: 100 });
    const live = [
      primary,
      session({ id: "c1", role: "child", groupPid: 100 }),
      session({ id: "c2", role: "child", groupPid: 100 }),
      session({ id: "other", role: "child", groupPid: 200 }),
    ];
    expect(childrenOf(primary, live).map((s) => s.id)).toEqual(["c1", "c2"]);
  });

  it("returns nothing when the primary has no groupPid", () => {
    const primary = session({ id: "p", groupPid: undefined });
    expect(childrenOf(primary, [session({ id: "c", groupPid: undefined })])).toEqual([]);
  });
});
