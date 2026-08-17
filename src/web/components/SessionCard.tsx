import { useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Eye,
  EyeOff,
  GitBranch,
  MoreHorizontal,
  Pin,
  PinOff,
  Play,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import type { SessionView, SessionPatch } from "../lib/apiClient";
import { resolveColor } from "../lib/colors";
import { displayName } from "../lib/sessions";
import { absoluteTime, relativeTime, shortId } from "../lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ColorPopover } from "./ColorPopover";

interface SessionCardProps {
  session: SessionView;
  busy: boolean;
  expanded: boolean;
  childSessions: SessionView[];
  childrenLoading: boolean;
  onToggleExpand: (id: string) => void;
  onResume: (session: SessionView) => void;
  onPatch: (id: string, patch: SessionPatch) => void;
  onRelated?: (session: SessionView) => void;
  /** Dedicated hide toggle (enables Undo); falls back to onPatch when absent. */
  onHide?: (session: SessionView) => void;
  /** Open the full session detail drawer (triggered by clicking the card body). */
  onOpen?: (session: SessionView) => void;
  /** Whether this card is currently selected for a bulk action. */
  selected?: boolean;
  /** Whether selection mode is active (keeps the checkbox visible). */
  selectionActive?: boolean;
  /** Toggle selection; `shiftKey` requests a range select from the last anchor. */
  onToggleSelect?: (id: string, shiftKey: boolean) => void;
}

const LIVENESS_LABEL: Record<SessionView["liveness"], string> = {
  live: "Live",
  stale: "Stale",
  inactive: "Inactive",
};

const CHILD_DOT: Record<SessionView["liveness"], string> = {
  live: "bg-live",
  stale: "bg-stale",
  inactive: "bg-inactive",
};

export function SessionCard({
  session,
  busy,
  expanded,
  childSessions,
  childrenLoading,
  onToggleExpand,
  onResume,
  onPatch,
  onRelated,
  onHide,
  onOpen,
  selected = false,
  selectionActive = false,
  onToggleSelect,
}: SessionCardProps) {
  const color = resolveColor(session);
  const name = displayName(session);
  const childCount = session.childCount ?? 0;

  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  function startEdit() {
    setDraftTitle(session.title ?? session.name ?? "");
    setEditingTitle(true);
  }

  function commitTitle() {
    setEditingTitle(false);
    const next = draftTitle.trim();
    if (next !== (session.title ?? "")) {
      onPatch(session.id, { title: next });
    }
  }

  function applyColor(stored: string) {
    setPickerOpen(false);
    onPatch(session.id, { color: stored });
  }

  function onCardClick(e: ReactMouseEvent<HTMLElement>) {
    if (!onOpen) return;
    // Ignore clicks that land on an interactive control (buttons, inputs,
    // links, or an open popover/menu) — only a click on the card body opens detail.
    if ((e.target as HTMLElement).closest("button, input, a, [role=dialog], [role=menu]")) return;
    onOpen(session);
  }

  return (
    <article
      className={cn(
        "group relative flex flex-col gap-2.5 rounded-xl border border-border border-l-4 bg-card p-4 text-card-foreground shadow-sm transition-colors",
        onOpen && "cursor-pointer hover:border-border/80 hover:bg-accent/30",
        selected && "ring-2 ring-primary",
        session.hidden && "opacity-60",
        session.archived && "opacity-75",
      )}
      style={{ borderLeftColor: color }}
      onClick={onCardClick}
    >
      <header className="flex items-center gap-2">
        {onToggleSelect && (
          <Checkbox
            className={cn(
              "shrink-0 transition-opacity",
              !selected && !selectionActive && "opacity-0 group-hover:opacity-100",
            )}
            checked={selected}
            aria-label={`Select “${name}”`}
            disabled={busy}
            onClick={(e) => {
              onToggleSelect(session.id, e.shiftKey);
              e.stopPropagation();
            }}
          />
        )}
        <span className="relative shrink-0">
          <button
            type="button"
            className="size-3.5 rounded-full ring-offset-2 ring-offset-card transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            style={{ backgroundColor: color }}
            title="Change color"
            aria-label="Change tab color"
            disabled={busy}
            onClick={() => setPickerOpen((v) => !v)}
          />
          {pickerOpen && (
            <ColorPopover
              current={session.color ?? color}
              busy={busy}
              onApply={applyColor}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </span>

        {editingTitle ? (
          <Input
            className="h-7 flex-1"
            value={draftTitle}
            autoFocus
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              else if (e.key === "Escape") setEditingTitle(false);
            }}
          />
        ) : (
          <button
            className="min-w-0 flex-1 truncate text-left text-sm font-semibold hover:text-primary"
            type="button"
            title="Click to rename"
            onClick={startEdit}
          >
            {name}
          </button>
        )}

        {session.pinned && (
          <Pin
            className="size-3.5 shrink-0 fill-current text-primary"
            aria-label="Pinned"
          />
        )}
      </header>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={session.liveness}>{LIVENESS_LABEL[session.liveness]}</Badge>
        {session.role === "child" && (
          <Badge variant="outline" title="Co-located child / subagent session">
            child
          </Badge>
        )}
        {session.archived && (
          <Badge variant="secondary" title="Archived">
            archived
          </Badge>
        )}
        {session.managed && (
          <Badge variant="outline" title="Has tool-managed metadata">
            managed
          </Badge>
        )}
        <span
          className="ml-auto text-xs text-muted-foreground"
          title={absoluteTime(session.updatedAt)}
        >
          {relativeTime(session.updatedAt)}
        </span>
      </div>

      <div
        className={cn(
          "flex items-center gap-1 truncate font-mono text-xs text-muted-foreground",
          !session.cwdExists && "text-stale",
        )}
        title={session.cwdExists ? session.cwd : `${session.cwd} (missing on disk)`}
      >
        {!session.cwdExists && <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />}
        <span className="truncate">{session.cwd || "(no working directory)"}</span>
      </div>

      {(session.repository || session.branch) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {session.repository && (
            <span className="truncate font-medium text-foreground/80" title={session.repository}>
              {session.repository}
            </span>
          )}
          {session.branch && (
            <span className="flex items-center gap-1" title={`Branch: ${session.branch}`}>
              <GitBranch className="size-3" />
              {session.branch}
            </span>
          )}
        </div>
      )}

      {session.tags && session.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {session.tags.map((t) => (
            <Badge variant="secondary" key={t} title={`Tag: ${t}`}>
              {t}
            </Badge>
          ))}
        </div>
      )}

      {session.summary && (
        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground" title={session.summary}>
          {session.summary}
        </p>
      )}

      {childCount > 0 && (
        <div className="rounded-lg bg-muted/40 p-1">
          <button
            type="button"
            className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-expanded={expanded}
            onClick={() => onToggleExpand(session.id)}
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
              aria-hidden="true"
            />
            +{childCount} child session{childCount === 1 ? "" : "s"}
          </button>

          {expanded && (
            <ul className="mt-1 space-y-0.5">
              {childrenLoading && childSessions.length === 0 ? (
                <li className="px-2 py-1 text-xs text-muted-foreground">Loading…</li>
              ) : childSessions.length === 0 ? (
                <li className="px-2 py-1 text-xs text-muted-foreground">No live children found.</li>
              ) : (
                childSessions.map((child) => (
                  <li
                    className="flex items-center gap-2 px-2 py-1 text-xs"
                    key={child.id}
                    title={child.cwd}
                  >
                    <span
                      className={cn("size-1.5 shrink-0 rounded-full", CHILD_DOT[child.liveness])}
                      aria-hidden="true"
                    />
                    <span className="shrink-0 font-medium">
                      {child.title || child.name || shortId(child.id)}
                    </span>
                    <span className="truncate font-mono text-muted-foreground">{child.cwd}</span>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}

      <footer className="mt-auto flex items-center gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          className="flex-1"
          disabled={busy}
          onClick={() => onResume(session)}
        >
          <Play className="size-4" />
          Resume
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              disabled={busy}
              aria-label="More actions"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => onPatch(session.id, { pinned: !session.pinned })}
            >
              {session.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
              {session.pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => (onHide ? onHide(session) : onPatch(session.id, { hidden: !session.hidden }))}
            >
              {session.hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
              {session.hidden ? "Unhide" : "Hide"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onPatch(session.id, { archived: !session.archived })}
            >
              {session.archived ? (
                <ArchiveRestore className="size-4" />
              ) : (
                <Archive className="size-4" />
              )}
              {session.archived ? "Unarchive" : "Archive"}
            </DropdownMenuItem>
            {onRelated && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onRelated(session)}>
                  <Sparkles className="size-4" />
                  Related memory
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </footer>
    </article>
  );
}
