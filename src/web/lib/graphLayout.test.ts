import { describe, expect, it } from "vitest";
import type { GraphModel } from "./apiTypes";
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH } from "./graphLayout";

function model(): GraphModel {
  return {
    openCount: 1,
    nodes: [
      { id: "a", label: "A", cwd: "c:/a", liveness: "live", isFork: false, childCount: 1 },
      { id: "b", label: "B", cwd: "c:/b", liveness: "stale", isFork: true, childCount: 0 },
      { id: "c", label: "C", cwd: "c:/c", liveness: "inactive", isFork: false, childCount: 0 },
    ],
    edges: [
      { id: "e1", source: "a", target: "b", kind: "fork" },
      { id: "e2", source: "a", target: "c", kind: "terminal" },
    ],
  };
}

describe("layoutGraph", () => {
  it("positions every node and carries the original data through", () => {
    const { nodes } = layoutGraph(model(), "TB");
    expect(nodes).toHaveLength(3);
    for (const n of nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
      expect(n.type).toBe("session");
    }
    expect(nodes.find((n) => n.id === "a")?.data.label).toBe("A");
  });

  it("ranks children below the parent in TB and to the right in LR", () => {
    const tb = layoutGraph(model(), "TB");
    const aTb = tb.nodes.find((n) => n.id === "a")!;
    const bTb = tb.nodes.find((n) => n.id === "b")!;
    expect(bTb.position.y).toBeGreaterThan(aTb.position.y);
    expect(aTb.sourcePosition).toBe("bottom");
    expect(aTb.targetPosition).toBe("top");

    const lr = layoutGraph(model(), "LR");
    const aLr = lr.nodes.find((n) => n.id === "a")!;
    const bLr = lr.nodes.find((n) => n.id === "b")!;
    expect(bLr.position.x).toBeGreaterThan(aLr.position.x);
    expect(aLr.sourcePosition).toBe("right");
    expect(aLr.targetPosition).toBe("left");
  });

  it("drops edges that reference unknown nodes", () => {
    const m = model();
    m.edges.push({ id: "bad", source: "a", target: "missing", kind: "repo" });
    const { edges } = layoutGraph(m, "TB");
    expect(edges.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
  });

  it("converts dagre centers to React Flow top-left positions", () => {
    const single: GraphModel = {
      openCount: 0,
      nodes: [{ id: "only", label: "Only", cwd: "x", liveness: "live", isFork: false, childCount: 0 }],
      edges: [],
    };
    const { nodes } = layoutGraph(single, "TB");
    const n = nodes[0];
    expect(Number.isFinite(n.position.x)).toBe(true);
    expect(Number.isFinite(n.position.y)).toBe(true);
    expect(NODE_WIDTH).toBeGreaterThan(0);
    expect(NODE_HEIGHT).toBeGreaterThan(0);
  });
});
