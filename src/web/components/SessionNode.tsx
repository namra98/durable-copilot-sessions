import { createContext, useContext } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { GitBranch, MoreHorizontal, Play, Plus, Sparkles, Users } from "lucide-react";
import type { GraphNode } from "../lib/apiTypes";
import { toCssColor } from "../lib/colors";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

  const color = node.color ? toCssColor(node.color) : "#4f8cff";
  const busy = actions.busyId === node.id;

  return (
    <div
      className={cn(
        "w-60 rounded-xl border border-l-4 border-border bg-card text-card-foreground shadow-sm transition-shadow hover:shadow-md",
        props.selected && "ring-2 ring-ring",
      )}
      style={{ borderLeftColor: color }}
    >
      <Handle type="target" position={props.targetPosition ?? Position.Top} />

      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          />
          <span className="flex-1 truncate text-sm font-semibold" title={node.label}>
            {node.label}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="-mr-1 text-muted-foreground"
                aria-label="Node actions"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={busy} onSelect={() => actions.onFork(node)}>
                <GitBranch />
                Fork…
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onSelect={() => actions.onNewChild(node)}>
                <Plus />
                New child
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.onRelated(node)}>
                <Sparkles />
                Related memory
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={node.liveness}>{LIVENESS_LABEL[node.liveness]}</Badge>
          {node.isFork && (
            <Badge variant="secondary" title="Created via fork">
              <GitBranch />
              fork
            </Badge>
          )}
          {node.childCount > 0 && (
            <Badge variant="outline" title="Co-located child sessions">
              <Users />
              {node.childCount}
            </Badge>
          )}
        </div>

        {(node.repository || node.branch) && (
          <div className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
            {node.repository && (
              <span className="truncate" title={node.repository}>
                {node.repository}
              </span>
            )}
            {node.branch && (
              <span className="flex items-center gap-1 truncate" title={`Branch: ${node.branch}`}>
                <GitBranch className="size-3 shrink-0" />
                {node.branch}
              </span>
            )}
          </div>
        )}

        <Button
          type="button"
          size="sm"
          className="w-full"
          disabled={busy}
          onClick={() => actions.onResume(node)}
        >
          <Play />
          Resume
        </Button>
      </div>

      <Handle
        type="source"
        position={props.sourcePosition ?? Position.Bottom}
      />
    </div>
  );
}
