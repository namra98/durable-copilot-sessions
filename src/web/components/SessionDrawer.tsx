import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Memory } from "../lib/apiTypes";
import type { WindowTarget } from "../lib/apiTypes";
import * as api from "../lib/apiClient";
import type { SessionPatch, SessionView } from "../lib/apiClient";
import { resolveColor } from "../lib/colors";
import { displayName } from "../lib/sessions";
import { triggerDownload } from "../lib/download";
import { absoluteTime, relativeTime, shortId } from "../lib/format";
import type { PushOptions, ToastKind } from "./Toast";
import { ColorPopover } from "./ColorPopover";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  Copy,
  Download,
  GitBranch,
  Pin,
  Play,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";

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

/**
 * A right-side, non-modal push panel showing the full detail of one session.
 * App places it in a flex row beside the main content; Escape or the Close
 * button dismisses it.
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

  const panelRef = useRef<HTMLElement>(null);
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

  // Remember what had focus, move focus into the panel, then restore on close.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      restoreFocusRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
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
        confirmCopilotStateWrite: true,
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
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="relative inline-flex">
          <button
            type="button"
            className={cn(
              "size-4 shrink-0 rounded-full ring-1 ring-inset ring-black/10 transition-transform",
              "hover:scale-110 disabled:cursor-not-allowed disabled:opacity-50",
            )}
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
          <Input
            className="h-8 flex-1"
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
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left",
              "text-sm font-semibold transition-colors hover:text-primary disabled:opacity-60",
            )}
            title="Click to rename"
            disabled={!session}
            onClick={startEdit}
          >
            <span className="truncate">{title}</span>
            {session?.pinned && (
              <Pin className="size-3.5 shrink-0 text-primary" aria-label="Pinned" />
            )}
          </button>
        )}

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close session detail"
          onClick={onClose}
        >
          <X />
        </Button>
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
    <aside
      className={cn(
        "flex h-full w-[440px] shrink-0 flex-col overflow-hidden border-l border-border bg-card text-card-foreground",
        "animate-in slide-in-from-right-2 fade-in duration-150",
      )}
      aria-label="Session detail"
      ref={panelRef}
      tabIndex={-1}
    >
      {header}

      {loading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
          <p className="text-sm text-muted-foreground">Loading session…</p>
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
          <p className="text-sm font-semibold">Couldn’t load session</p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
      ) : session ? (
        <div className="flex-1 overflow-y-auto">
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => onResume(session)}>
                <Play />
                Resume
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setForkOpen((v) => !v)}
              >
                <GitBranch />
                Fork…
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => applyPatch({ pinned: !session.pinned })}
              >
                <Pin />
                {session.pinned ? "Unpin" : "Pin"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => applyPatch({ hidden: !session.hidden })}
              >
                {session.hidden ? "Unhide" : "Hide"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => applyPatch({ archived: !session.archived })}
              >
                {session.archived ? "Unarchive" : "Archive"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                title="Download the session transcript as markdown"
                onClick={() => void downloadTranscript()}
              >
                <Download />
                Transcript
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onShowRelated(session.id, displayName(session))}
              >
                <Sparkles />
                Related
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void copy(session.id, "Session id")}
              >
                <Copy />
                Copy id
              </Button>
            </div>

            {forkOpen && (
              <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="fork-note">Lineage note (optional)</Label>
                  <Input
                    id="fork-note"
                    value={forkNote}
                    autoFocus
                    placeholder="try the alternate approach"
                    onChange={(e) => setForkNote(e.target.value)}
                  />
                </div>
                <Label className="cursor-pointer font-normal">
                  <Checkbox
                    checked={forkLaunch}
                    onCheckedChange={(v) => setForkLaunch(v === true)}
                  />
                  Open a terminal tab for the fork
                </Label>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setForkOpen(false)}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" onClick={() => void submitFork()} disabled={busy}>
                    Create fork
                  </Button>
                </div>
              </div>
            )}

            <Separator />

            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={session.liveness} title={`Liveness: ${session.liveness}`}>
                {LIVENESS_LABEL[session.liveness]}
              </Badge>
              <Badge variant="outline" title="Session role">
                {session.role === "child" ? "child" : "primary"}
              </Badge>
              {session.branchOf && (
                <Badge variant="outline" title="Created via fork">
                  <GitBranch />
                  fork
                </Badge>
              )}
              {session.managed && (
                <Badge variant="secondary" title="Has tool-managed metadata">
                  managed
                </Badge>
              )}
            </div>

            <div className="space-y-2.5">
              <DetailRow label="Session id">
                <code className="min-w-0 break-all font-mono text-xs">{session.id}</code>
                <CopyButton label="Copy session id" onClick={() => void copy(session.id, "Session id")} />
              </DetailRow>

              {session.repository && (
                <DetailRow label="Repository">
                  <span>{session.repository}</span>
                </DetailRow>
              )}
              {session.branch && (
                <DetailRow label="Branch">
                  <span className="flex min-w-0 items-center gap-1">
                    <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{session.branch}</span>
                  </span>
                </DetailRow>
              )}

              <DetailRow label="Working dir">
                <code
                  className={cn(
                    "min-w-0 break-all font-mono text-xs",
                    !session.cwdExists && "text-destructive",
                  )}
                >
                  {!session.cwdExists && (
                    <TriangleAlert
                      className="mr-1 inline size-3.5 align-text-bottom"
                      aria-hidden="true"
                    />
                  )}
                  {session.cwd || "(no working directory)"}
                </code>
                {session.cwd && (
                  <CopyButton
                    label="Copy working directory path"
                    onClick={() => void copy(session.cwd, "Path")}
                  />
                )}
              </DetailRow>
              {!session.cwdExists && session.cwd && (
                <p className="text-xs text-destructive">This working directory is missing on disk.</p>
              )}

              {session.gitRoot && (
                <DetailRow label="Git root">
                  <code className="min-w-0 break-all font-mono text-xs">{session.gitRoot}</code>
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
                  <span className="font-mono text-xs">{session.livePids.join(", ")}</span>
                </DetailRow>
              )}
              {session.groupPid !== undefined && (
                <DetailRow label="Group PID">
                  <span className="font-mono text-xs">{session.groupPid}</span>
                </DetailRow>
              )}

              {parent && (
                <DetailRow label="Forked from">
                  <button
                    type="button"
                    className="font-mono text-xs text-primary hover:underline"
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
            </div>

            {session.summary && (
              <>
                <Separator />
                <section className="space-y-2">
                  <SectionTitle>Summary</SectionTitle>
                  <p className="text-sm leading-relaxed text-muted-foreground">{session.summary}</p>
                </section>
              </>
            )}

            <Separator />

            <section className="space-y-2">
              <SectionTitle count={session.tags?.length || undefined}>Tags</SectionTitle>
              <div className="flex flex-wrap gap-1.5">
                {(session.tags ?? []).map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
                  >
                    {t}
                    <button
                      type="button"
                      className="text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                      aria-label={`Remove tag ${t}`}
                      disabled={busy}
                      onClick={() => removeTag(t)}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
                {(!session.tags || session.tags.length === 0) && (
                  <span className="text-xs text-muted-foreground">No tags yet.</span>
                )}
              </div>
              <div className="flex gap-2">
                <Input
                  className="h-8"
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
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || !tagDraft.trim()}
                  onClick={addTag}
                >
                  Add
                </Button>
              </div>
            </section>

            <Separator />

            <section className="space-y-2">
              <SectionTitle count={childCount}>Children</SectionTitle>
              {children.length === 0 ? (
                <p className="text-xs text-muted-foreground">No live child sessions.</p>
              ) : (
                <ul className="space-y-1">
                  {children.map((child) => (
                    <li key={child.id} className="flex items-center gap-2">
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          child.liveness === "live" && "bg-live",
                          child.liveness === "stale" && "bg-stale",
                          child.liveness === "inactive" && "bg-inactive",
                        )}
                        aria-hidden="true"
                      />
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-sm transition-colors hover:text-primary"
                        title={child.cwd}
                        onClick={() => onOpen(child.id)}
                      >
                        {child.title || child.name || shortId(child.id)}
                      </button>
                      <Button variant="ghost" size="xs" onClick={() => onResume(child)}>
                        Resume
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <Separator />
            <MemorySection title="Session memories" memories={memories} />
            <Separator />
            <MemorySection title="Related memories" memories={related} />
          </div>
        </div>
      ) : null}
    </aside>
  );
}

interface DetailRowProps {
  label: string;
  children: ReactNode;
}

function DetailRow({ label, children }: DetailRowProps) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-start gap-3 text-sm">
      <span className="pt-0.5 text-xs font-medium text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5">{children}</span>
    </div>
  );
}

interface SectionTitleProps {
  count?: number;
  children: ReactNode;
}

function SectionTitle({ count, children }: SectionTitleProps) {
  return (
    <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
      {count !== undefined && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </h4>
  );
}

interface CopyButtonProps {
  label: string;
  onClick: () => void;
}

function CopyButton({ label, onClick }: CopyButtonProps) {
  return (
    <button
      type="button"
      className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      aria-label={label}
      onClick={onClick}
    >
      <Copy className="size-3.5" />
    </button>
  );
}

interface MemorySectionProps {
  title: string;
  memories: Memory[] | null;
}

function MemorySection({ title, memories }: MemorySectionProps) {
  return (
    <section className="space-y-2">
      <SectionTitle count={memories ? memories.length : undefined}>{title}</SectionTitle>
      {memories === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : memories.length === 0 ? (
        <p className="text-xs text-muted-foreground">None found.</p>
      ) : (
        <div className="space-y-2">
          {memories.map((m) => (
            <article
              key={m.id}
              className="space-y-1 rounded-lg border border-border bg-muted/30 p-2.5"
            >
              <header className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">
                  {KIND_LABEL[m.kind]}
                </Badge>
                {m.title && (
                  <span className="truncate text-xs font-medium" title={m.title}>
                    {m.title}
                  </span>
                )}
              </header>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                {m.content}
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
