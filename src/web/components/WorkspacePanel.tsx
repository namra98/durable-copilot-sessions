import { RotateCcw, Trash2 } from "lucide-react";
import type { Workspace } from "../../core/types";
import { absoluteTime, relativeTime } from "../lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface WorkspacePanelProps {
  workspaces: Workspace[];
  busy: boolean;
  onRestore: (workspace: Workspace) => void;
  onDelete: (workspace: Workspace) => void;
}

function countTabs(workspace: Workspace): number {
  return workspace.windows.reduce((sum, w) => sum + w.tabs.length, 0);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function WorkspacePanel({ workspaces, busy, onRestore, onDelete }: WorkspacePanelProps) {
  if (workspaces.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
        No saved workspaces yet. Use “Save current as workspace…” or “Snapshot now”.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {workspaces.map((ws) => {
        const tabs = countTabs(ws);
        return (
          <li key={ws.id}>
            <Card className="flex-row items-center justify-between gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold">{ws.name}</span>
                  <Badge variant="secondary" title="Source">
                    {ws.source}
                  </Badge>
                  <Badge variant="outline">{plural(tabs, "tab")}</Badge>
                </div>
                {ws.description && (
                  <p className="mt-1 text-sm text-muted-foreground">{ws.description}</p>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{plural(ws.windows.length, "window")}</span>
                  <span aria-hidden="true">·</span>
                  <span>{plural(tabs, "tab")}</span>
                  <span aria-hidden="true">·</span>
                  <span title={absoluteTime(ws.updatedAt)}>updated {relativeTime(ws.updatedAt)}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button type="button" size="sm" disabled={busy} onClick={() => onRestore(ws)}>
                  <RotateCcw />
                  Restore
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={busy}
                  onClick={() => onDelete(ws)}
                >
                  <Trash2 />
                  Delete
                </Button>
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
