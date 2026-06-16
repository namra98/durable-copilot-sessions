import { useState } from "react";
import type { SessionView, SessionPatch } from "../api/client";
import { resolveColor } from "../lib/colors";
import { displayName } from "../lib/sessions";
import { absoluteTime, relativeTime, shortId } from "../lib/format";
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
}

const LIVENESS_LABEL: Record<SessionView["liveness"], string> = {
  live: "Live",
  stale: "Stale",
  inactive: "Inactive",
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

  return (
    <article
      className={`card${session.hidden ? " card--hidden" : ""}`}
      style={{ borderLeftColor: color }}
    >
      <header className="card__head">
        <span className="card__dot-wrap">
          <button
            type="button"
            className="card__dot card__dot--btn"
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
          <input
            className="card__title-input"
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
          <button className="card__title" type="button" title="Click to rename" onClick={startEdit}>
            {name}
          </button>
        )}

        {session.pinned && <span className="pin" title="Pinned" aria-label="Pinned">📌</span>}
      </header>

      <div className="card__meta">
        <span className={`badge badge--${session.liveness}`} title={`Liveness: ${session.liveness}`}>
          {LIVENESS_LABEL[session.liveness]}
        </span>
        {session.role === "child" && (
          <span className="tag" title="Co-located child / subagent session">child</span>
        )}
        {session.managed && <span className="tag" title="Has tool-managed metadata">managed</span>}
        <span className="card__time" title={absoluteTime(session.updatedAt)}>
          {relativeTime(session.updatedAt)}
        </span>
      </div>

      <div
        className={`card__path${session.cwdExists ? "" : " card__path--missing"}`}
        title={session.cwdExists ? session.cwd : `${session.cwd} (missing on disk)`}
      >
        {!session.cwdExists && <span className="card__path-warn" aria-hidden="true">⚠ </span>}
        {session.cwd || "(no working directory)"}
      </div>

      {(session.repository || session.branch) && (
        <div className="card__repo">
          {session.repository && (
            <span className="card__repo-name" title={session.repository}>
              {session.repository}
            </span>
          )}
          {session.branch && (
            <span className="card__branch" title={`Branch: ${session.branch}`}>
              ⎇ {session.branch}
            </span>
          )}
        </div>
      )}

      {session.summary && (
        <p className="card__summary" title={session.summary}>
          {session.summary}
        </p>
      )}

      {childCount > 0 && (
        <div className="card__children">
          <button
            type="button"
            className="disclosure"
            aria-expanded={expanded}
            onClick={() => onToggleExpand(session.id)}
          >
            <span
              className={`disclosure__caret${expanded ? " disclosure__caret--open" : ""}`}
              aria-hidden="true"
            >
              ▸
            </span>
            +{childCount} child session{childCount === 1 ? "" : "s"}
          </button>

          {expanded && (
            <ul className="childlist">
              {childrenLoading && childSessions.length === 0 ? (
                <li className="childlist__empty">Loading…</li>
              ) : childSessions.length === 0 ? (
                <li className="childlist__empty">No live children found.</li>
              ) : (
                childSessions.map((child) => (
                  <li className="childrow" key={child.id} title={child.cwd}>
                    <span className={`childrow__dot childrow__dot--${child.liveness}`} aria-hidden="true" />
                    <span className="childrow__name">
                      {child.title || child.name || shortId(child.id)}
                    </span>
                    <span className="childrow__cwd">{child.cwd}</span>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}

      <footer className="card__actions">
        <button
          className="btn btn--primary btn--resume"
          type="button"
          disabled={busy}
          onClick={() => onResume(session)}
        >
          ▶ Resume
        </button>
        <button
          className="btn btn--ghost"
          type="button"
          disabled={busy}
          onClick={() => onPatch(session.id, { pinned: !session.pinned })}
        >
          {session.pinned ? "Unpin" : "Pin"}
        </button>
        <button
          className="btn btn--ghost"
          type="button"
          disabled={busy}
          onClick={() => onPatch(session.id, { hidden: !session.hidden })}
        >
          {session.hidden ? "Unhide" : "Hide"}
        </button>
        {onRelated && (
          <button
            className="btn btn--ghost"
            type="button"
            title="Show related memories"
            onClick={() => onRelated(session)}
          >
            ◎ Related
          </button>
        )}
      </footer>
    </article>
  );
}
