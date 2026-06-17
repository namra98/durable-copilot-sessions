import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Clock, RotateCcw } from "lucide-react";
import type { WindowTarget, Workspace } from "../../core/types";
import * as api from "../api/client";
import type { WorkspaceDiff } from "../api/client";
import { absoluteTime, relativeTime } from "../lib/format";
import type { PushOptions, ToastKind } from "./Toast";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

type PushFn = (kind: ToastKind, text: string, options?: PushOptions) => number;

interface SnapshotTimelineProps {
  windowTarget: WindowTarget;
  busy: boolean;
  push: PushFn;
  /** Restore a snapshot (delegated to the App for shared progress handling). */
  onRestore: (ws: Workspace) => void;
  /** Called after a snapshot is promoted so the App can refresh its workspaces. */
  onPromoted: () => void;
}

function countTabs(ws: Workspace): number {
  return ws.windows.reduce((sum, w) => sum + w.tabs.length, 0);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Auto-snapshot timeline with per-snapshot restore / promote / diff actions. */
export function SnapshotTimeline({ windowTarget: _windowTarget, busy, push, onRestore, onPromoted }: SnapshotTimelineProps) {
  const [snapshots, setSnapshots] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listSnapshots()
      .then((list) => {
        setSnapshots(list);
        setUnavailable(false);
      })
      .catch((err) => {
        if (/(404|not found)/i.test(errorMessage(err))) setUnavailable(true);
        setSnapshots([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function select(id: string) {
    setSelectedId((curr) => (curr === id ? null : id));
    setDiff(null);
  }

  async function showDiff(id: string) {
    setDiffLoading(true);
    setDiff(null);
    try {
      setDiff(await api.getWorkspaceDiff(id));
    } catch (err) {
      push("error", `Diff failed: ${errorMessage(err)}`);
    } finally {
      setDiffLoading(false);
    }
  }

  async function promote(ws: Workspace) {
    const name = window.prompt("Promote snapshot to a named workspace:", ws.name.replace(/^auto[- ]?/i, ""));
    if (!name || !name.trim()) return;
    setActionBusy(true);
    try {
      await api.promoteSnapshot(ws.id, name.trim());
      push("success", `Promoted snapshot to “${name.trim()}”.`);
      onPromoted();
      load();
    } catch (err) {
      push("error", `Promote failed: ${errorMessage(err)}`);
    } finally {
      setActionBusy(false);
    }
  }

  if (unavailable) return null;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          Auto-snapshots
          <Badge variant="secondary">{snapshots.length}</Badge>
        </h2>
        <Button type="button" size="sm" variant="ghost" onClick={load} disabled={loading}>
          Refresh
        </Button>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading snapshots…</p>
      ) : snapshots.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
          No auto-snapshots captured yet.
        </p>
      ) : (
        <ol className="flex flex-col">
          {snapshots.map((snap) => {
            const selected = selectedId === snap.id;
            return (
              <li className="border-b border-border last:border-0" key={snap.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                  aria-expanded={selected}
                  onClick={() => select(snap.id)}
                >
                  <ChevronRight
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform",
                      selected && "rotate-90",
                    )}
                    aria-hidden="true"
                  />
                  <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{snap.name}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span title={absoluteTime(snap.createdAt)}>{relativeTime(snap.createdAt)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{snap.windows.length} win</span>
                      <span aria-hidden="true">·</span>
                      <span>{countTabs(snap)} tab{countTabs(snap) === 1 ? "" : "s"}</span>
                    </span>
                  </span>
                </button>

                {selected && (
                  <div className="flex flex-col gap-3 px-2 pb-3 pl-9">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="xs"
                        disabled={busy || actionBusy}
                        onClick={() => onRestore(snap)}
                      >
                        <RotateCcw />
                        Restore
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="secondary"
                        disabled={busy || actionBusy}
                        onClick={() => void promote(snap)}
                      >
                        Promote…
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={diffLoading}
                        onClick={() => void showDiff(snap.id)}
                      >
                        What changed
                      </Button>
                    </div>

                    {diffLoading ? (
                      <p className="text-xs text-muted-foreground">Computing diff…</p>
                    ) : diff ? (
                      <DiffSummary diff={diff} />
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function DiffSummary({ diff }: { diff: WorkspaceDiff }) {
  const buckets: { key: keyof WorkspaceDiff; label: string }[] = [
    { key: "missing", label: "Missing" },
    { key: "staleCwd", label: "Stale cwd" },
    { key: "changed", label: "Changed" },
    { key: "addedLive", label: "Added live" },
  ];
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {buckets.map((b) => {
          const entries = diff[b.key] as { sessionId: string; title: string; detail: string }[];
          return (
            <Badge variant="outline" key={b.key}>
              {b.label} <strong className="font-semibold">{entries.length}</strong>
            </Badge>
          );
        })}
        <Badge variant="outline">
          Unchanged <strong className="font-semibold">{diff.unchanged}</strong>
        </Badge>
      </div>
      {buckets.map((b) => {
        const entries = diff[b.key] as { sessionId: string; title: string; detail: string }[];
        if (entries.length === 0) return null;
        return (
          <div className="flex flex-col gap-1" key={b.key}>
            <Separator />
            <h5 className="text-xs font-semibold text-muted-foreground">{b.label}</h5>
            <ul className="flex flex-col gap-1">
              {entries.map((e) => (
                <li
                  className="flex items-baseline justify-between gap-2 text-xs"
                  key={`${b.key}:${e.sessionId}`}
                  title={e.detail}
                >
                  <span className="truncate font-medium">{e.title}</span>
                  <span className="shrink-0 font-mono text-muted-foreground">{e.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
