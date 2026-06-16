import { describe, it, expect } from "vitest";
import { buildGraph } from "./buildGraph.js";
import { defaultConfig } from "../config.js";
import type { DiscoveredSession, ManagedSession } from "../types.js";

function s(
  id: string,
  opts: Partial<DiscoveredSession> = {},
): DiscoveredSession {
  return {
    id,
    cwd: "C:/x",
    cwdExists: true,
    liveness: "live",
    livePids: [],
    topLevel: true,
    ...opts,
  };
}

describe("buildGraph", () => {
  it("creates a node per session with color, role, fork and child counts", () => {
    const sessions = [
      s("parent", { name: "Parent", livePids: [10], updatedAt: "2026-01-02T00:00:00Z" }),
      s("child", { name: "Child", livePids: [10], updatedAt: "2026-01-01T00:00:00Z" }),
    ];
    const managed = new Map<string, ManagedSession>([
      ["parent", { sessionId: "parent", color: "#FF0000", updatedAt: "" }],
    ]);
    const g = buildGraph(sessions, managed, defaultConfig);
    expect(g.nodes).toHaveLength(2);
    const parent = g.nodes.find((n) => n.id === "parent")!;
    expect(parent.color).toBe("#FF0000");
    expect(parent.role).toBe("primary");
    expect(parent.childCount).toBe(1);
    // terminal edge primary -> child
    expect(g.edges.some((e) => e.kind === "terminal" && e.source === "parent" && e.target === "child")).toBe(true);
    expect(g.openCount).toBe(1);
  });

  it("draws fork edges from branchOf when the parent is present", () => {
    const sessions = [
      s("orig", { name: "Original", liveness: "inactive", livePids: [] }),
      s("fork1", { name: "Branch", liveness: "inactive", livePids: [], branchOf: "orig" }),
    ];
    const g = buildGraph(sessions, new Map(), defaultConfig);
    expect(g.nodes.find((n) => n.id === "fork1")!.isFork).toBe(true);
    expect(g.edges.some((e) => e.kind === "fork" && e.source === "orig" && e.target === "fork1")).toBe(true);
  });

  it("omits fork edges whose parent is not in the set", () => {
    const sessions = [s("fork1", { branchOf: "missing-parent" })];
    const g = buildGraph(sessions, new Map(), defaultConfig);
    expect(g.edges.filter((e) => e.kind === "fork")).toHaveLength(0);
    expect(g.nodes[0].isFork).toBe(true);
  });
});
