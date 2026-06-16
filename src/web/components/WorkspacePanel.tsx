import type { Workspace } from "../../core/types";
import { absoluteTime, relativeTime } from "../lib/format";

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
      <p className="empty">
        No saved workspaces yet. Use “Save current as workspace…” or “Snapshot now”.
      </p>
    );
  }

  return (
    <ul className="ws-list">
      {workspaces.map((ws) => {
        const tabs = countTabs(ws);
        return (
          <li className="ws" key={ws.id}>
            <div className="ws__info">
              <div className="ws__title-row">
                <span className="ws__name">{ws.name}</span>
                <span className={`tag tag--src tag--src-${ws.source}`} title="Source">{ws.source}</span>
              </div>
              {ws.description && <p className="ws__desc">{ws.description}</p>}
              <div className="ws__meta">
                <span>{plural(ws.windows.length, "window")}</span>
                <span className="ws__dot">·</span>
                <span>{plural(tabs, "tab")}</span>
                <span className="ws__dot">·</span>
                <span title={absoluteTime(ws.updatedAt)}>updated {relativeTime(ws.updatedAt)}</span>
              </div>
            </div>
            <div className="ws__actions">
              <button
                className="btn btn--primary"
                type="button"
                disabled={busy}
                onClick={() => onRestore(ws)}
              >
                Restore
              </button>
              <button
                className="btn btn--danger"
                type="button"
                disabled={busy}
                onClick={() => onDelete(ws)}
              >
                Delete
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
