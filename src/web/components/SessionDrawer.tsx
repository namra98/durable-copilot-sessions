import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Memory } from "../../core/types";
import type { WindowTarget } from "../../core/types";
import * as api from "../api/client";
import type { SessionPatch, SessionView } from "../api/client";
import { resolveColor } from "../lib/colors";
import { displayName } from "../lib/sessions";
import { triggerDownload } from "../lib/download";
import { absoluteTime, relativeTime, shortId } from "../lib/format";
import type { PushOptions, ToastKind } from "./Toast";
import { ColorPopover } from "./ColorPopover";

type PushFn = (kind: ToastKind, text: string, options?: PushOptions) => number;

interface SessionDrawerProps {
  /** The session id to show. Changing it refetches the drawer. */
  id: string;
  windowTarget: WindowTarget;
  push: PushFn;
  /** Close the drawer (scrim click / Esc / Close button). */
  onClose: () => void;
  /** Open a different session in this drawer (e.g. a parent or child). */
  onOpen: (id: string) => void;
  /** Resume a session (delegated to the App so its lists stay in sync). */
  onResume: (session: SessionView) => void;
  /** Patch managed metadata (delegated to the App; updates the shared lists). */
  onPatch: (id: string, patch: SessionPatch) => void;
  /** Jump to the Memory view filtered to this session's related memories. */
  onShowRelated: (sessionId: string, label: string) => void;
  /** Refresh the App's session lists (e.g. after a fork). */
  onReload: () => void;
}

const LIVENESS_LABEL: Record<SessionView["liveness"], string> = {
  live: "Live",
  stale: "Stale",
  inactive: "Inactive",
};

const KIND_LABEL: Record<Memory["kind"], string> = {
  chat: "Chat",
  decision: "Decision",
  todo: "Todo",
  learning: "Learning",
  summary: "Summary",
  file_context: "File",
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A right-side slide-in pane showing the full detail of one session over a
 * scrim. Focus is trapped while open; Escape or a scrim click closes it.
 */
export function SessionDrawer(props: SessionDrawerProps) {
  const { id, windowTarget, push, onClose, onOpen, onResume, onPatch, onShowRelated, onReload } = props;

  const [session, setSession] = useState<SessionView | null>(null);
  const [children, setChildren] = useState<SessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [related, setRelated] = useState<Memory[] | null>(null);

  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [forkNote, setForkNote] = useState("");
  const [forkLaunch, setForkLaunch] = useState(true);
  const [tagDraft, setTagDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Fetch the session detail whenever the target id changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSession(null);
    setChildren([]);
    setEditingTitle(false);
    setPickerOpen(false);
    setForkOpen(false);
    api
      .getSessionDetail(id)
      .then((detail) => {
        if (cancelled) return;
        setSession(detail.session);
        setChildren(detail.children);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Fetch this session's memories + related memories alongside the detail.
  useEffect(() => {
    let cancelled = false;
    setMemories(null);
    setRelated(null);
    api
      .sessionMemory(id)
      .then((m) => {
        if (!cancelled) setMemories(m);
      })
      .catch(() => {
        if (!cancelled) setMemories([]);
      });
    api
      .relatedMemory(id)
      .then((m) => {
        if (!cancelled) setRelated(m);
      })
      .catch(() => {
        if (!cancelled) setRelated([]);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Remember what had focus, then trap focus inside the drawer while open.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const node = panelRef.current;
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();
    return () => {
      restoreFocusRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const node = panelRef.current;
      if (!node) return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusable.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === firstEl || active === node)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const applyPatch = useCallback(
    (patch: SessionPatch) => {
      setSession((curr) => (curr ? { ...curr, ...patch, managed: true } : curr));
      onPatch(id, patch);
    },
    [id, onPatch],
  );

  const copy = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        push("success", `${label} copied.`);
      } catch {
        push("error", "Clipboard unavailable — copy blocked by the browser.");
      }
    },
    [push],
  );

  const startEdit = useCallback(() => {
    if (!session) return;
    setDraftTitle(session.title ?? session.name ?? "");
    setEditingTitle(true);
  }, [session]);

  const commitTitle = useCallback(() => {
    setEditingTitle(false);
    if (!session) return;
    const next = draftTitle.trim();
    if (next !== (session.title ?? "")) applyPatch({ title: next });
  }, [applyPatch, draftTitle, session]);

  const submitFork = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    try {
      const result = await api.forkSession(session.id, {
        note: forkNote.trim() || undefined,
        launch: forkLaunch,
        color: session.color ?? resolveColor(session),
        window: windowTarget,
      });
      setForkOpen(false);
      setForkNote("");
      const launched = result.launch?.ok ? " · launched" : "";
      push("success", `Forked “${displayName(session)}”${launched}`);
      onReload();
    } catch (err) {
      push("error", `Fork failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [forkLaunch, forkNote, onReload, push, session, windowTarget]);

  const addTag = useCallback(() => {
    if (!session) return;
    const next = tagDraft.trim();
    if (!next) return;
    const existing = session.tags ?? [];
    if (existing.includes(next)) {
      setTagDraft("");
      return;
    }
    applyPatch({ tags: [...existing, next] });
    setTagDraft("");
  }, [applyPatch, session, tagDraft]);

  const removeTag = useCallback(
    (tag: string) => {
      if (!session) return;
      const existing = session.tags ?? [];
      applyPatch({ tags: existing.filter((t) => t !== tag) });
    },
    [applyPatch, session],
  );

  const downloadTranscript = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    try {
      const md = await api.getTranscript(session.id);
      triggerDownload(`${session.id}.md`, md, "text/markdown");
      push("success", "Transcript downloaded.");
    } catch (err) {
      push("error", `Transcript failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [push, session]);

  const color = session ? resolveColor(session) : "#4f8cff";
  const title = session ? displayName(session) : shortId(id);
  const childCount = session?.childCount ?? children.length;

  const parent = session?.branchOf;

  const header = useMemo(
    () => (
      <div className="drawer__head">
        <span className="drawer__dot-wrap">
          <button
            type="button"
            className="drawer__dot"
            style={{ backgroundColor: color }}
            title="Change color"
            aria-label="Change tab color"
            disabled={!session || busy}
            onClick={() => setPickerOpen((v) => !v)}
          />
          {pickerOpen && session && (
            <ColorPopover
              current={session.color ?? color}
              busy={busy}
              onApply={(stored) => {
                setPickerOpen(false);
                applyPatch({ color: stored });
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </span>

        {editingTitle && session ? (
          <input
            className="drawer__title-input"
            value={draftTitle}
            autoFocus
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              else if (e.key === "Escape") {
                e.stopPropagation();
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="drawer__title"
            title="Click to rename"
            disabled={!session}
            onClick={startEdit}
          >
            {title}
            {session?.pinned && <span className="pin" title="Pinned" aria-label="Pinned"> 📌</span>}
          </button>
        )}

        <button
          type="button"
          className="drawer__close"
          aria-label="Close session detail"
          onClick={onClose}
        >
          ×
        </button>
      </div>
    ),
    [
      applyPatch,
      busy,
      color,
      commitTitle,
      draftTitle,
      editingTitle,
      onClose,
      pickerOpen,
      session,
      startEdit,
      title,
    ],
  );

  return (
    <div className="drawer-scrim" role="presentation" onMouseDown={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Session detail"
        ref={panelRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {header}

        {loading ? (
          <div className="drawer__body drawer__body--center">
            <p className="empty__sub">Loading session…</p>
          </div>
        ) : error ? (
          <div className="drawer__body drawer__body--center">
            <p className="empty__title">Couldn’t load session</p>
            <p className="empty__sub">{error}</p>
          </div>
        ) : session ? (
          <>
            <div className="drawer__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => onResume(session)}
              >
                ▶ Resume
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setForkOpen((v) => !v)}
              >
                ⑂ Fork…
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => applyPatch({ pinned: !session.pinned })}
              >
                {session.pinned ? "Unpin" : "Pin"}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => applyPatch({ hidden: !session.hidden })}
              >
                {session.hidden ? "Unhide" : "Hide"}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => applyPatch({ archived: !session.archived })}
              >
                {session.archived ? "Unarchive" : "Archive"}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                title="Download the session transcript as markdown"
                onClick={() => void downloadTranscript()}
              >
                ⭳ Transcript
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => onShowRelated(session.id, displayName(session))}
              >
                ◎ Related
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void copy(session.id, "Session id")}
              >
                Copy id
              </button>
            </div>

            {forkOpen && (
              <div className="drawer__fork">
                <label className="field field--block">
                  <span className="field__label">Lineage note (optional)</span>
                  <input
                    className="input"
                    value={forkNote}
                    autoFocus
                    placeholder="try the alternate approach"
                    onChange={(e) => setForkNote(e.target.value)}
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={forkLaunch}
                    onChange={(e) => setForkLaunch(e.target.checked)}
                  />
                  Open a terminal tab for the fork
                </label>
                <div className="modal__actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setForkOpen(false)}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => void submitFork()}
                    disabled={busy}
                  >
                    Create fork
                  </button>
                </div>
              </div>
            )}

            <div className="drawer__body">
              <div className="drawer__badges">
                <span
                  className={`badge badge--${session.liveness}`}
                  title={`Liveness: ${session.liveness}`}
                >
                  {LIVENESS_LABEL[session.liveness]}
                </span>
                <span className="tag" title="Session role">
                  {session.role === "child" ? "child" : "primary"}
                </span>
                {session.branchOf && (
                  <span className="tag tag--fork" title="Created via fork">
                    ⑂ fork
                  </span>
                )}
                {session.managed && <span className="tag" title="Has tool-managed metadata">managed</span>}
              </div>

              <DetailRow label="Session id">
                <code className="drawer__id">{session.id}</code>
                <button
                  type="button"
                  className="drawer__copy"
                  aria-label="Copy session id"
                  onClick={() => void copy(session.id, "Session id")}
                >
                  ⧉
                </button>
              </DetailRow>

              {session.repository && (
                <DetailRow label="Repository">
                  <span>{session.repository}</span>
                </DetailRow>
              )}
              {session.branch && (
                <DetailRow label="Branch">
                  <span>⎇ {session.branch}</span>
                </DetailRow>
              )}

              <DetailRow label="Working dir">
                <code className={`drawer__path${session.cwdExists ? "" : " drawer__path--missing"}`}>
                  {!session.cwdExists && <span aria-hidden="true">⚠ </span>}
                  {session.cwd || "(no working directory)"}
                </code>
                {session.cwd && (
                  <button
                    type="button"
                    className="drawer__copy"
                    aria-label="Copy working directory path"
                    onClick={() => void copy(session.cwd, "Path")}
                  >
                    ⧉
                  </button>
                )}
              </DetailRow>
              {!session.cwdExists && session.cwd && (
                <p className="drawer__hint drawer__hint--warn">This working directory is missing on disk.</p>
              )}

              {session.gitRoot && (
                <DetailRow label="Git root">
                  <code className="drawer__path">{session.gitRoot}</code>
                </DetailRow>
              )}
              {session.clientName && (
                <DetailRow label="Client">
                  <span>{session.clientName}</span>
                </DetailRow>
              )}

              <DetailRow label="Created">
                <span title={absoluteTime(session.createdAt)}>{relativeTime(session.createdAt)}</span>
              </DetailRow>
              <DetailRow label="Updated">
                <span title={absoluteTime(session.updatedAt)}>{relativeTime(session.updatedAt)}</span>
              </DetailRow>

              {session.livePids.length > 0 && (
                <DetailRow label="Live PIDs">
                  <span>{session.livePids.join(", ")}</span>
                </DetailRow>
              )}
              {session.groupPid !== undefined && (
                <DetailRow label="Group PID">
                  <span>{session.groupPid}</span>
                </DetailRow>
              )}

              {parent && (
                <DetailRow label="Forked from">
                  <button
                    type="button"
                    className="drawer__link"
                    onClick={() => onOpen(parent)}
                    title="Open the parent session"
                  >
                    {shortId(parent)}
                  </button>
                </DetailRow>
              )}
              {session.branchNote && (
                <DetailRow label="Branch note">
                  <span>{session.branchNote}</span>
                </DetailRow>
              )}

              {session.summary && (
                <div className="drawer__section">
                  <h4 className="drawer__section-title">Summary</h4>
                  <p className="drawer__summary">{session.summary}</p>
                </div>
              )}

              <div className="drawer__section">
                <h4 className="drawer__section-title">
                  Tags
                  {session.tags && session.tags.length > 0 && (
                    <span className="count">{session.tags.length}</span>
                  )}
                </h4>
                <div className="drawer__tags">
                  {(session.tags ?? []).map((t) => (
                    <span className="tagchip tagchip--removable" key={t}>
                      {t}
                      <button
                        type="button"
                        className="tagchip__remove"
                        aria-label={`Remove tag ${t}`}
                        disabled={busy}
                        onClick={() => removeTag(t)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {(!session.tags || session.tags.length === 0) && (
                    <span className="drawer__hint">No tags yet.</span>
                  )}
                </div>
                <div className="drawer__tag-add">
                  <input
                    className="input"
                    value={tagDraft}
                    placeholder="add a tag…"
                    aria-label="Add tag"
                    disabled={busy}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTag();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--xs"
                    disabled={busy || !tagDraft.trim()}
                    onClick={addTag}
                  >
                    Add
                  </button>
                </div>
              </div>

              <div className="drawer__section">
                <h4 className="drawer__section-title">
                  Children <span className="count">{childCount}</span>
                </h4>
                {children.length === 0 ? (
                  <p className="drawer__hint">No live child sessions.</p>
                ) : (
                  <ul className="drawer__children">
                    {children.map((child) => (
                      <li className="drawer__child" key={child.id}>
                        <span
                          className={`childrow__dot childrow__dot--${child.liveness}`}
                          aria-hidden="true"
                        />
                        <button
                          type="button"
                          className="drawer__child-name"
                          title={child.cwd}
                          onClick={() => onOpen(child.id)}
                        >
                          {child.title || child.name || shortId(child.id)}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--xs"
                          onClick={() => onResume(child)}
                        >
                          Resume
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <MemorySection title="Session memories" memories={memories} />
              <MemorySection title="Related memories" memories={related} />
            </div>
          </>
        ) : null}
      </aside>
    </div>
  );
}

interface DetailRowProps {
  label: string;
  children: ReactNode;
}

function DetailRow({ label, children }: DetailRowProps) {
  return (
    <div className="drawer__row">
      <span className="drawer__row-label">{label}</span>
      <span className="drawer__row-value">{children}</span>
    </div>
  );
}

interface MemorySectionProps {
  title: string;
  memories: Memory[] | null;
}

function MemorySection({ title, memories }: MemorySectionProps) {
  return (
    <div className="drawer__section">
      <h4 className="drawer__section-title">
        {title}
        {memories && <span className="count">{memories.length}</span>}
      </h4>
      {memories === null ? (
        <p className="drawer__hint">Loading…</p>
      ) : memories.length === 0 ? (
        <p className="drawer__hint">None found.</p>
      ) : (
        <div className="drawer__memlist">
          {memories.map((m) => (
            <article className="drawer__memcard" key={m.id}>
              <header className="drawer__memhead">
                <span className={`memchip memchip--${m.kind}`}>{KIND_LABEL[m.kind]}</span>
                {m.title && <span className="drawer__memtitle" title={m.title}>{m.title}</span>}
              </header>
              <p className="drawer__membody">{m.content}</p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
