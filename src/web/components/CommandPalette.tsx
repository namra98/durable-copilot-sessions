import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Workspace } from "../../core/types";
import type { SessionView } from "../api/client";
import { displayName } from "../lib/sessions";
import { shortId } from "../lib/format";
import { fuzzyRank } from "../lib/fuzzy";

/** A discrete command (not tied to a session or workspace). */
export interface PaletteAction {
  id: string;
  label: string;
  /** Short right-aligned hint, e.g. a shortcut or category. */
  hint?: string;
  run: () => void;
}

type Entry =
  | { kind: "action"; key: string; text: string; label: string; hint?: string; action: PaletteAction }
  | { kind: "session"; key: string; text: string; label: string; hint?: string; session: SessionView }
  | { kind: "workspace"; key: string; text: string; label: string; hint?: string; workspace: Workspace };

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

const KIND_LABEL: Record<Entry["kind"], string> = {
  action: "Action",
  session: "Session",
  workspace: "Workspace",
};

/**
 * A centered, keyboard-driven command palette (Ctrl/Cmd+K). Fuzzy-filters over
 * actions, loaded sessions, and saved workspaces. Arrow keys navigate, Enter
 * activates, Shift+Enter resumes a session, and Escape closes.
 */
export function CommandPalette(props: CommandPaletteProps) {
  const { sessions, workspaces, actions, onClose, onOpenSession, onResumeSession, onRestoreWorkspace } =
    props;

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Build the candidate set once per data change: actions, then sessions, then
  // workspaces (this order is what an empty query shows).
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const a of actions) {
      out.push({ kind: "action", key: `a:${a.id}`, text: a.label, label: a.label, hint: a.hint, action: a });
    }
    for (const s of sessions) {
      const name = displayName(s);
      const text = [name, s.repository, s.branch, s.cwd, s.id].filter(Boolean).join(" ");
      const hint = s.repository || s.branch || shortId(s.id);
      out.push({ kind: "session", key: `s:${s.id}`, text, label: name, hint, session: s });
    }
    for (const w of workspaces) {
      const text = [w.name, w.description].filter(Boolean).join(" ");
      out.push({
        kind: "workspace",
        key: `w:${w.id}`,
        text,
        label: w.name,
        hint: w.description,
        workspace: w,
      });
    }
    return out;
  }, [actions, sessions, workspaces]);

  const results = useMemo(() => {
    const ranked = fuzzyRank(query, entries.map((e) => ({ item: e, text: e.text })));
    return ranked.map((r) => r.item);
  }, [entries, query]);

  // Keep the active index in range whenever the result set changes.
  useEffect(() => {
    setActive((curr) => (results.length === 0 ? 0 : Math.min(curr, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const activate = useCallback(
    (entry: Entry | undefined, resume: boolean) => {
      if (!entry) return;
      onClose();
      if (entry.kind === "action") entry.action.run();
      else if (entry.kind === "session") {
        if (resume) onResumeSession(entry.session);
        else onOpenSession(entry.session.id);
      } else {
        onRestoreWorkspace(entry.workspace);
      }
    },
    [onClose, onOpenSession, onRestoreWorkspace, onResumeSession],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((curr) => (results.length === 0 ? 0 : (curr + 1) % results.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((curr) => (results.length === 0 ? 0 : (curr - 1 + results.length) % results.length));
      } else if (e.key === "Enter") {
        e.preventDefault();
        activate(results[active], e.shiftKey);
      }
    },
    [activate, active, onClose, results],
  );

  // Scroll the active row into view as the selection moves.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div className="palette-scrim" role="presentation" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette__search">
          <span className="palette__search-icon" aria-hidden="true">⌘</span>
          <input
            ref={inputRef}
            className="palette__input"
            type="text"
            value={query}
            placeholder="Search sessions, workspaces, and actions…"
            aria-label="Command palette search"
            aria-controls="palette-list"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
          <kbd className="palette__hint">Esc</kbd>
        </div>

        {results.length === 0 ? (
          <div className="palette__empty">No matches.</div>
        ) : (
          <ul className="palette__list" id="palette-list" role="listbox" ref={listRef}>
            {results.map((entry, i) => (
              <li
                key={entry.key}
                data-index={i}
                role="option"
                aria-selected={i === active}
                className={`palette__item${i === active ? " palette__item--active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  activate(entry, e.shiftKey);
                }}
              >
                <span className={`palette__kind palette__kind--${entry.kind}`}>
                  {KIND_LABEL[entry.kind]}
                </span>
                <span className="palette__label" title={entry.label}>
                  {entry.label}
                </span>
                {entry.hint && (
                  <span className="palette__item-hint" title={entry.hint}>
                    {entry.hint}
                  </span>
                )}
                {entry.kind === "session" && (
                  <span className="palette__shift" title="Shift+Enter to resume">
                    ⇧↵ resume
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="palette__foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>⇧↵</kbd> resume</span>
        </div>
      </div>
    </div>
  );
}
