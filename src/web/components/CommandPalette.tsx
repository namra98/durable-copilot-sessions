import { LayoutGrid, Play, Sparkles, TerminalSquare } from "lucide-react";
import type { Workspace } from "../lib/apiTypes";
import type { SessionView } from "../lib/apiClient";
import { displayName } from "../lib/sessions";
import { shortId } from "../lib/format";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

/** A discrete command (not tied to a session or workspace). */
export interface PaletteAction {
  id: string;
  label: string;
  /** Short right-aligned hint, e.g. a shortcut or category. */
  hint?: string;
  run: () => void;
}

interface CommandPaletteProps {
  sessions: SessionView[];
  workspaces: Workspace[];
  actions: PaletteAction[];
  onClose: () => void;
  /** Open a session in the detail drawer (Enter on a session). */
  onOpenSession: (id: string) => void;
  /** Resume a session (Shift+Enter on a session). */
  onResumeSession: (session: SessionView) => void;
  /** Restore a workspace (Enter on a workspace). */
  onRestoreWorkspace: (workspace: Workspace) => void;
}

/**
 * A centered, keyboard-driven command palette (Ctrl/Cmd+K). Searches over
 * actions, loaded sessions, and saved workspaces. The underlying cmdk dialog
 * handles search, filtering, arrow-key navigation, and Escape/overlay close.
 */
export function CommandPalette(props: CommandPaletteProps) {
  const { sessions, workspaces, actions, onClose, onOpenSession, onResumeSession, onRestoreWorkspace } =
    props;

  return (
    <CommandDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Command palette"
      description="Search sessions, workspaces, and actions"
      className="sm:max-w-xl"
    >
      <CommandInput placeholder="Search sessions, workspaces, and actions…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>

        {actions.length > 0 && (
          <CommandGroup heading="Actions">
            {actions.map((a) => (
              <CommandItem
                key={`a:${a.id}`}
                value={`action ${a.label} ${a.hint ?? ""}`}
                onSelect={() => {
                  onClose();
                  a.run();
                }}
              >
                <Sparkles />
                <span className="truncate">{a.label}</span>
                {a.hint && (
                  <span className="ml-auto truncate text-xs text-muted-foreground">{a.hint}</span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {actions.length > 0 && sessions.length > 0 && <CommandSeparator />}

        {sessions.length > 0 && (
          <CommandGroup heading="Sessions">
            {sessions.map((s) => {
              const name = displayName(s);
              const hint = s.repository || s.branch || shortId(s.id);
              return (
                <CommandItem
                  key={`s:${s.id}`}
                  value={`session ${[name, s.repository, s.branch, s.cwd, s.id]
                    .filter(Boolean)
                    .join(" ")}`}
                  onSelect={() => {
                    onClose();
                    onOpenSession(s.id);
                  }}
                >
                  <TerminalSquare />
                  <span className="truncate">{name}</span>
                  {hint && (
                    <span className="truncate font-mono text-xs text-muted-foreground">{hint}</span>
                  )}
                  <button
                    type="button"
                    className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    title="Resume session"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose();
                      onResumeSession(s);
                    }}
                  >
                    <Play className="size-3" />
                    Resume
                  </button>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {sessions.length > 0 && workspaces.length > 0 && <CommandSeparator />}

        {workspaces.length > 0 && (
          <CommandGroup heading="Workspaces">
            {workspaces.map((w) => (
              <CommandItem
                key={`w:${w.id}`}
                value={`workspace ${[w.name, w.description].filter(Boolean).join(" ")}`}
                onSelect={() => {
                  onClose();
                  onRestoreWorkspace(w);
                }}
              >
                <LayoutGrid />
                <span className="truncate">{w.name}</span>
                {w.description && (
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {w.description}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
