import type {
  AppConfig,
  DiscoveredSession,
  GraphEdge,
  GraphModel,
  GraphNode,
  ManagedSession,
} from "../types.js";
import { annotateOpen, tabFor } from "../snapshot/grouping.js";

/**
 * Build the session graph: nodes are sessions, edges are relationships.
 *  - "fork"     edges follow `branchOf` lineage (parent -> branch).
 *  - "terminal" edges connect a primary session to its co-located children
 *               (sessions sharing the same live Copilot PID).
 * Edges are only drawn between sessions present in the provided set; switch to
 * the "all" filter to see full lineage across inactive sessions.
 */
export function buildGraph(
  sessions: DiscoveredSession[],
  managedById: Map<string, ManagedSession>,
  config: Pick<AppConfig, "colorStrategy">,
): GraphModel {
  const ann = annotateOpen(sessions);
  const ids = new Set(sessions.map((s) => s.id));

  const nodes: GraphNode[] = sessions.map((s) => {
    const managed = managedById.get(s.id);
    return {
      id: s.id,
      label: managed?.title ?? s.name ?? s.id.slice(0, 8),
      repository: s.repository,
      branch: s.branch,
      cwd: s.cwd,
      color: tabFor(s, managed, config).color,
      liveness: s.liveness,
      role: ann.roleById.get(s.id),
      isFork: typeof s.branchOf === "string" && s.branchOf.length > 0,
      childCount: ann.childrenById.get(s.id)?.length ?? 0,
    };
  });

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (edge: GraphEdge): void => {
    if (!seen.has(edge.id)) {
      seen.add(edge.id);
      edges.push(edge);
    }
  };

  for (const s of sessions) {
    if (s.branchOf && ids.has(s.branchOf)) {
      add({ id: `fork:${s.branchOf}->${s.id}`, source: s.branchOf, target: s.id, kind: "fork" });
    }
  }
  for (const [primaryId, childIds] of ann.childrenById) {
    if (!ids.has(primaryId)) continue;
    for (const childId of childIds) {
      if (!ids.has(childId)) continue;
      add({
        id: `terminal:${primaryId}->${childId}`,
        source: primaryId,
        target: childId,
        kind: "terminal",
      });
    }
  }

  return { nodes, edges, openCount: ann.openCount };
}
