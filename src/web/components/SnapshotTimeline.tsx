import { useCallback, useEffect, useState } from "react";
import type { WindowTarget, Workspace } from "../../core/types";
import * as api from "../api/client";
import type { WorkspaceDiff } from "../api/client";
import { absoluteTime, relativeTime } from "../lib/format";
import type { PushOptions, ToastKind } from "./Toast";

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
    <section className="panel">
      <div className="panel__head">
        <h2>
          Auto-snapshots <span className="count">{snapshots.length}</span>
        </h2>
        <button type="button" className="btn btn--ghost" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="empty__sub">Loading snapshots…</p>
      ) : snapshots.length === 0 ? (
        <p className="empty">No auto-snapshots captured yet.</p>
      ) : (
        <ol className="timeline">
          {snapshots.map((snap) => {
            const selected = selectedId === snap.id;
            return (
              <li className={`timeline__item${selected ? " timeline__item--on" : ""}`} key={snap.id}>
                <button
                  type="button"
                  className="timeline__node"
                  aria-expanded={selected}
                  onClick={() => select(snap.id)}
                >
                  <span className="timeline__dot" aria-hidden="true" />
                  <span className="timeline__body">
                    <span className="timeline__name">{snap.name}</span>
                    <span className="timeline__meta">
                      <span title={absoluteTime(snap.createdAt)}>{relativeTime(snap.createdAt)}</span>
                      <span className="ws__dot">·</span>
                      <span>{snap.windows.length} win</span>
                      <span className="ws__dot">·</span>
                      <span>{countTabs(snap)} tab{countTabs(snap) === 1 ? "" : "s"}</span>
                    </span>
                  </span>
                </button>

                {selected && (
                  <div className="timeline__detail">
                    <div className="timeline__actions">
                      <button
                        type="button"
                        className="btn btn--primary btn--xs"
                        disabled={busy || actionBusy}
                        onClick={() => onRestore(snap)}
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        className="btn btn--xs"
                        disabled={busy || actionBusy}
                        onClick={() => void promote(snap)}
                      >
                        Promote…
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--xs"
                        disabled={diffLoading}
                        onClick={() => void showDiff(snap.id)}
                      >
                        What changed
                      </button>
                    </div>

                    {diffLoading ? (
                      <p className="drawer__hint">Computing diff…</p>
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
    <div className="diff">
      <div className="diff__counts">
        {buckets.map((b) => {
          const entries = diff[b.key] as { sessionId: string; title: string; detail: string }[];
          return (
            <span className="diff__count" key={b.key}>
              {b.label} <strong>{entries.length}</strong>
            </span>
          );
        })}
        <span className="diff__count">
          Unchanged <strong>{diff.unchanged}</strong>
        </span>
      </div>
      {buckets.map((b) => {
        const entries = diff[b.key] as { sessionId: string; title: string; detail: string }[];
        if (entries.length === 0) return null;
        return (
          <div className="diff__group" key={b.key}>
            <h5 className="diff__group-title">{b.label}</h5>
            <ul className="diff__list">
              {entries.map((e) => (
                <li className="diff__entry" key={`${b.key}:${e.sessionId}`} title={e.detail}>
                  <span className="diff__entry-title">{e.title}</span>
                  <span className="diff__entry-detail">{e.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
