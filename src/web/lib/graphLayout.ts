/**
 * Pure, framework-agnostic graph layout: turn a {@link GraphModel} into
 * positioned React Flow nodes and edges using dagre.
 *
 * This file imports no DOM or React Flow runtime so it can be unit-tested under
 * the node-only vitest environment. The returned objects are plain data that
 * React Flow consumes directly (`{ id, position, data, type }` / `{ id, source,
 * target, ... }`).
 */
import dagre from "@dagrejs/dagre";
import type { GraphEdge, GraphModel, GraphNode } from "../../core/types";

/** Dagre layout direction: top-to-bottom or left-to-right. */
export type LayoutDirection = "TB" | "LR";

/** Default rendered node footprint (px) used for dagre spacing + centering. */
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 160;

/** A React-Flow-shaped node carrying the original {@link GraphNode} as data. */
export interface FlowNode {
  id: string;
  type: "session";
  position: { x: number; y: number };
  data: GraphNode;
  /** Source/target handle orientation, derived from the layout direction. */
  sourcePosition: "bottom" | "right";
  targetPosition: "top" | "left";
}

/** A React-Flow-shaped edge carrying the original kind for styling. */
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  data: { kind: GraphEdge["kind"] };
}

/** Both halves of a laid-out graph, ready to hand to `<ReactFlow>`. */
export interface LayoutResult {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/**
 * Lay out a graph model top-down (default) or left-right with dagre. Nodes whose
 * edges reference a missing endpoint are still placed; dagre treats unknown edge
 * endpoints defensively, so we drop edges that reference unknown nodes to keep
 * the layout (and React Flow) consistent.
 */
export function layoutGraph(
  model: GraphModel,
  direction: LayoutDirection = "TB",
): LayoutResult {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: direction === "TB" ? 56 : 44,
    ranksep: direction === "TB" ? 88 : 120,
    marginx: 28,
    marginy: 28,
  });

  const known = new Set<string>();
  for (const node of model.nodes) {
    known.add(node.id);
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  const validEdges = model.edges.filter((e) => known.has(e.source) && known.has(e.target));
  for (const edge of validEdges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const horizontal = direction === "LR";
  const nodes: FlowNode[] = model.nodes.map((node) => {
    const laid = g.node(node.id) as { x: number; y: number } | undefined;
    const cx = laid?.x ?? 0;
    const cy = laid?.y ?? 0;
    return {
      id: node.id,
      type: "session",
      // React Flow positions are top-left; dagre gives node centers.
      position: { x: cx - NODE_WIDTH / 2, y: cy - NODE_HEIGHT / 2 },
      data: node,
      sourcePosition: horizontal ? "right" : "bottom",
      targetPosition: horizontal ? "left" : "top",
    };
  });

  const edges: FlowEdge[] = validEdges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    data: { kind: edge.kind },
  }));

  return { nodes, edges };
}
