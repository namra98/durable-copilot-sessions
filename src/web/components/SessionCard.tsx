import { useState } from "react";
import type { SessionView, SessionPatch } from "../api/client";
import { COLOR_SWATCHES, resolveColor, toCssColor } from "../lib/colors";
import { absoluteTime, relativeTime, shortId } from "../lib/format";

interface SessionCardProps {
  session: SessionView;
  busy: boolean;
  onResume: (session: SessionView) => void;
  onPatch: (id: string, patch: SessionPatch) => void;
}

const LIVENESS_LABEL: Record<SessionView["liveness"], string> = {
  live: "Live",
  stale: "Stale",
  inactive: "Inactive",
};

export function SessionCard({ session, busy, onResume, onPatch }: SessionCardProps) {
  const color = resolveColor(session);
  const displayName = session.title || session.name || shortId(session.id);
  const activeColor = toCssColor(session.color ?? "");

  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");

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

  return (
    <article
      className={`card${session.hidden ? " card--hidden" : ""}`}
      style={{ borderLeftColor: color }}
    >
      <header className="card__head">
        <span className="card__dot" style={{ backgroundColor: color }} aria-hidden="true" />
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
          <button
            className="card__title"
            type="button"
            title="Click to rename"
            onClick={startEdit}
          >
            {displayName}
          </button>
        )}
        {session.pinned && (
          <span className="pin" title="Pinned" aria-label="Pinned">📌</span>
        )}
      </header>

      <div className="card__meta">
        <span className={`badge badge--${session.liveness}`} title={`Liveness: ${session.liveness}`}>
          {LIVENESS_LABEL[session.liveness]}
        </span>
        {session.topLevel && (
          <span className="tag tag--top" title="Top-level interactive session">top-level</span>
        )}
        {session.managed && (
          <span className="tag" title="Has tool-managed metadata">managed</span>
        )}
        <span className="card__time" title={absoluteTime(session.updatedAt)}>
          {relativeTime(session.updatedAt)}
        </span>
      </div>

      <div
        className={`card__path${session.cwdExists ? "" : " card__path--missing"}`}
        title={session.cwdExists ? session.cwd : `${session.cwd} (missing on disk)`}
      >
        {session.cwd}
      </div>

      {(session.repository || session.branch) && (
        <div className="card__repo">
          {session.repository && <span className="card__repo-name">{session.repository}</span>}
          {session.branch && <span className="card__branch" title="Branch">⎇ {session.branch}</span>}
        </div>
      )}

      {session.summary && (
        <p className="card__summary" title={session.summary}>{session.summary}</p>
      )}

      <div className="card__swatches" role="group" aria-label="Tab color">
        {COLOR_SWATCHES.map((sw) => {
          const active = activeColor.toLowerCase() === sw.toLowerCase();
          return (
            <button
              key={sw}
              type="button"
              className={`swatch${active ? " swatch--active" : ""}`}
              style={{ backgroundColor: sw }}
              title={`Set color ${sw}`}
              aria-label={`Set tab color ${sw}`}
              aria-pressed={active}
              disabled={busy}
              onClick={() => onPatch(session.id, { color: sw })}
            />
          );
        })}
      </div>

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
      </footer>
    </article>
  );
}
