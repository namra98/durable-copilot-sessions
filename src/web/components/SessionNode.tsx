import { createContext, useContext, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import type { GraphNode } from "../../core/types";
import { toCssColor } from "../lib/colors";

/**
 * Actions a session node can trigger, supplied by the enclosing graph view via
 * context so the laid-out node data can stay pure (plain {@link GraphNode}).
 */
export interface NodeActions {
  onResume: (node: GraphNode) => void;
  onFork: (node: GraphNode) => void;
  onNewChild: (node: GraphNode) => void;
  onRelated: (node: GraphNode) => void;
  busyId: string | null;
}

const noop = (): void => undefined;

export const NodeActionsContext = createContext<NodeActions>({
  onResume: noop,
  onFork: noop,
  onNewChild: noop,
  onRelated: noop,
  busyId: null,
});

const LIVENESS_LABEL: Record<GraphNode["liveness"], string> = {
  live: "Live",
  stale: "Stale",
  inactive: "Inactive",
};

/** A draggable card node: color rail, label, repo/branch, liveness + badges. */
export function SessionNode(props: NodeProps) {
  const node = props.data as unknown as GraphNode;
  const actions = useContext(NodeActionsContext);
  const [menuOpen, setMenuOpen] = useState(false);

  const color = node.color ? toCssColor(node.color) : "#4f8cff";
  const busy = actions.busyId === node.id;

  return (
    <div
      className={`gnode gnode--${node.liveness}${props.selected ? " gnode--sel" : ""}`}
      style={{ borderLeftColor: color }}
      onMouseLeave={() => setMenuOpen(false)}
    >
      <Handle type="target" position={props.targetPosition ?? Position.Top} />

      <div className="gnode__head">
        <span
          className={`gnode__dot gnode__dot--${node.liveness}`}
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <span className="gnode__label" title={node.label}>
          {node.label}
        </span>
        <button
          type="button"
          className="gnode__menu-btn"
          aria-label="Node actions"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          ⋯
        </button>
      </div>

      <div className="gnode__meta">
        <span className={`gnode__badge gnode__badge--${node.liveness}`}>
          {LIVENESS_LABEL[node.liveness]}
        </span>
        {node.isFork && (
          <span className="gnode__badge gnode__badge--fork" title="Created via fork">
            ⑂ fork
          </span>
        )}
        {node.childCount > 0 && (
          <span className="gnode__badge gnode__badge--children" title="Co-located child sessions">
            +{node.childCount}
          </span>
        )}
      </div>

      {(node.repository || node.branch) && (
        <div className="gnode__repo">
          {node.repository && (
            <span className="gnode__repo-name" title={node.repository}>
              {node.repository}
            </span>
          )}
          {node.branch && (
            <span className="gnode__branch" title={`Branch: ${node.branch}`}>
              ⎇ {node.branch}
            </span>
          )}
        </div>
      )}

      <div className="gnode__actions">
        <button
          type="button"
          className="gnode__btn gnode__btn--primary"
          disabled={busy}
          onClick={() => actions.onResume(node)}
        >
          ▶ Resume
        </button>
        {menuOpen && (
          <div className="gnode__menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="gnode__menu-item"
              disabled={busy}
              onClick={() => {
                setMenuOpen(false);
                actions.onFork(node);
              }}
            >
              ⑂ Fork…
            </button>
            <button
              type="button"
              role="menuitem"
              className="gnode__menu-item"
              disabled={busy}
              onClick={() => {
                setMenuOpen(false);
                actions.onNewChild(node);
              }}
            >
              ＋ New child
            </button>
            <button
              type="button"
              role="menuitem"
              className="gnode__menu-item"
              onClick={() => {
                setMenuOpen(false);
                actions.onRelated(node);
              }}
            >
              ◎ Related memory
            </button>
          </div>
        )}
      </div>

      <Handle
        type="source"
        position={props.sourcePosition ?? Position.Bottom}
      />
    </div>
  );
}
