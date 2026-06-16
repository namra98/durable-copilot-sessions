import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { AppConfig, LaunchResult, WindowTarget, Workspace } from "../core/types";
import * as api from "./api/client";
import type {
  CreateWorkspaceBody,
  SessionFilter,
  SessionPatch,
  SessionView,
} from "./api/client";
import { SessionCard } from "./components/SessionCard";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { ToastStack, useToasts } from "./components/Toast";
import { resolveColor } from "./lib/colors";

const AUTO_REFRESH_MS = 15000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeLaunch(result: LaunchResult): string {
  const tabs = `${result.tabsLaunched} tab${result.tabsLaunched === 1 ? "" : "s"}`;
  const windows = `${result.windowsOpened} window${result.windowsOpened === 1 ? "" : "s"}`;
  return `${tabs} in ${windows}`;
}

export function App() {
  const { toasts, push, dismiss } = useToasts();

  const [filter, setFilter] = useState<SessionFilter>("live");
  const [windowTarget, setWindowTarget] = useState<WindowTarget>("new");
  const [showHidden, setShowHidden] = useState(false);

  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [version, setVersion] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const [globalBusy, setGlobalBusy] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  // One-time: load config + server health for the header.
  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => undefined);
    api
      .getHealth()
      .then((h) => setVersion(h.version))
      .catch(() => undefined);
  }, []);

  // Load sessions + workspaces on mount and whenever the filter changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.listSessions(filter), api.listWorkspaces()])
      .then(([s, w]) => {
        if (cancelled) return;
        setSessions(s);
        setWorkspaces(w);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter]);

  // Silent auto-refresh.
  useEffect(() => {
    const id = window.setInterval(() => {
      api.listSessions(filter).then(setSessions).catch(() => undefined);
      api.listWorkspaces().then(setWorkspaces).catch(() => undefined);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [filter]);

  const setBusy = useCallback((id: string, value: boolean) => {
    setBusyIds((curr) => ({ ...curr, [id]: value }));
  }, []);

  const reportLaunch = useCallback(
    (result: LaunchResult, label: string) => {
      if (result.ok) {
        const warn = result.warnings.length ? ` — ${result.warnings.join("; ")}` : "";
        push(result.warnings.length ? "info" : "success", `${label} · ${describeLaunch(result)}${warn}`);
      } else {
        push("error", `${label} failed: ${result.error ?? "unknown error"}`);
      }
    },
    [push],
  );

  const manualRefresh = useCallback(async () => {
    setError(null);
    try {
      const [s, w] = await Promise.all([api.listSessions(filter), api.listWorkspaces()]);
      setSessions(s);
      setWorkspaces(w);
      push("info", "Refreshed.");
    } catch (err) {
      setError(errorMessage(err));
      push("error", `Refresh failed: ${errorMessage(err)}`);
    }
  }, [filter, push]);

  const handlePatch = useCallback(
    async (id: string, patch: SessionPatch) => {
      setBusy(id, true);
      setSessions((curr) => curr.map((s) => (s.id === id ? { ...s, ...patch, managed: true } : s)));
      try {
        const updated = await api.patchSession(id, patch);
        setSessions((curr) => curr.map((s) => (s.id === id ? updated : s)));
      } catch (err) {
        push("error", `Update failed: ${errorMessage(err)}`);
        api.listSessions(filter).then(setSessions).catch(() => undefined);
      } finally {
        setBusy(id, false);
      }
    },
    [filter, push, setBusy],
  );

  const handleResume = useCallback(
    async (session: SessionView) => {
      setBusy(session.id, true);
      try {
        const result = await api.resumeSession(session.id, {
          window: windowTarget,
          color: session.color ?? resolveColor(session),
          title: session.title ?? session.name,
        });
        const label = `Resumed “${session.title || session.name || session.id}”`;
        reportLaunch(result, label);
      } catch (err) {
        push("error", `Resume failed: ${errorMessage(err)}`);
      } finally {
        setBusy(session.id, false);
      }
    },
    [windowTarget, push, reportLaunch, setBusy],
  );

  const handleRestore = useCallback(
    async (ws: Workspace) => {
      setGlobalBusy(true);
      try {
        const result = await api.restoreWorkspace(ws.id, { window: windowTarget });
        reportLaunch(result, `Restored “${ws.name}”`);
      } catch (err) {
        push("error", `Restore failed: ${errorMessage(err)}`);
      } finally {
        setGlobalBusy(false);
      }
    },
    [windowTarget, push, reportLaunch],
  );

  const handleDelete = useCallback(
    async (ws: Workspace) => {
      if (!window.confirm(`Delete workspace “${ws.name}”? This cannot be undone.`)) return;
      setGlobalBusy(true);
      try {
        await api.deleteWorkspace(ws.id);
        setWorkspaces((curr) => curr.filter((w) => w.id !== ws.id));
        push("success", `Deleted “${ws.name}”.`);
      } catch (err) {
        push("error", `Delete failed: ${errorMessage(err)}`);
      } finally {
        setGlobalBusy(false);
      }
    },
    [push],
  );

  const handleSnapshot = useCallback(async () => {
    setGlobalBusy(true);
    try {
      const ws = await api.snapshot();
      setWorkspaces((curr) => [ws, ...curr.filter((w) => w.id !== ws.id)]);
      push("success", `Snapshot saved: “${ws.name}”.`);
    } catch (err) {
      push("error", `Snapshot failed: ${errorMessage(err)}`);
    } finally {
      setGlobalBusy(false);
    }
  }, [push]);

  const handleCreateWorkspace = useCallback(
    async (body: CreateWorkspaceBody) => {
      setGlobalBusy(true);
      try {
        const ws = await api.createWorkspace(body);
        setWorkspaces((curr) => [ws, ...curr.filter((w) => w.id !== ws.id)]);
        setShowSaveDialog(false);
        push("success", `Saved workspace “${ws.name}”.`);
      } catch (err) {
        push("error", `Save failed: ${errorMessage(err)}`);
      } finally {
        setGlobalBusy(false);
      }
    },
    [push],
  );

  const hiddenCount = useMemo(() => sessions.filter((s) => s.hidden).length, [sessions]);

  const visibleSessions = useMemo(() => {
    const list = sessions.filter((s) => showHidden || !s.hidden);
    return list.slice().sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return tb - ta;
    });
  }, [sessions, showHidden]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__logo" aria-hidden="true">◆</span>
          <div>
            <h1 className="topbar__title">Durable Copilot Sessions</h1>
            <p className="topbar__sub">
              {version ? `v${version}` : "local dashboard"}
              {config ? ` · API :${config.apiPort}` : ""}
            </p>
          </div>
        </div>

        <div className="topbar__controls">
          <div className="seg" role="group" aria-label="Session filter">
            <button
              type="button"
              className={`seg__btn${filter === "live" ? " seg__btn--on" : ""}`}
              onClick={() => setFilter("live")}
            >
              Live only
            </button>
            <button
              type="button"
              className={`seg__btn${filter === "all" ? " seg__btn--on" : ""}`}
              onClick={() => setFilter("all")}
            >
              All
            </button>
          </div>

          <label className="field">
            <span className="field__label">Open in</span>
            <select
              className="select"
              value={windowTarget}
              onChange={(e) => setWindowTarget(e.target.value as WindowTarget)}
            >
              <option value="new">New window</option>
              <option value="current">Current window</option>
            </select>
          </label>

          <button
            type="button"
            className="btn"
            onClick={() => setShowSaveDialog(true)}
            disabled={globalBusy}
          >
            Save current as workspace…
          </button>
          <button type="button" className="btn" onClick={handleSnapshot} disabled={globalBusy}>
            Snapshot now
          </button>
          <button type="button" className="btn btn--primary" onClick={manualRefresh} disabled={loading}>
            Refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="banner banner--error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn--ghost" onClick={manualRefresh}>
            Retry
          </button>
        </div>
      )}

      <main className="content">
        <section className="panel">
          <div className="panel__head">
            <h2>
              Sessions <span className="count">{visibleSessions.length}</span>
            </h2>
            {hiddenCount > 0 && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(e) => setShowHidden(e.target.checked)}
                />
                Show hidden ({hiddenCount})
              </label>
            )}
          </div>

          {loading ? (
            <p className="empty">Loading sessions…</p>
          ) : visibleSessions.length === 0 ? (
            <p className="empty">No {filter === "live" ? "live " : ""}sessions found.</p>
          ) : (
            <div className="grid">
              {visibleSessions.map((s) => (
                <SessionCard
                  key={s.id}
                  session={s}
                  busy={Boolean(busyIds[s.id])}
                  onResume={handleResume}
                  onPatch={handlePatch}
                />
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel__head">
            <h2>
              Workspaces <span className="count">{workspaces.length}</span>
            </h2>
          </div>
          <WorkspacePanel
            workspaces={workspaces}
            busy={globalBusy}
            onRestore={handleRestore}
            onDelete={handleDelete}
          />
        </section>
      </main>

      {showSaveDialog && (
        <SaveWorkspaceDialog
          defaultFilter={filter}
          busy={globalBusy}
          onCancel={() => setShowSaveDialog(false)}
          onSave={handleCreateWorkspace}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

interface SaveDialogProps {
  defaultFilter: SessionFilter;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: CreateWorkspaceBody) => void;
}

function SaveWorkspaceDialog({ defaultFilter, busy, onCancel, onSave }: SaveDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fromLive, setFromLive] = useState(true);
  const [captureFilter, setCaptureFilter] = useState<SessionFilter>(defaultFilter);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave({
      name: trimmed,
      description: description.trim() || undefined,
      fromLive,
      filter: captureFilter,
    });
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Save current as workspace"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h3 className="modal__title">Save current as workspace</h3>

        <label className="field field--block">
          <span className="field__label">Name</span>
          <input
            className="input"
            value={name}
            autoFocus
            placeholder="morning-layout"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="field field--block">
          <span className="field__label">Description (optional)</span>
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={fromLive}
            onChange={(e) => setFromLive(e.target.checked)}
          />
          Capture the current live layout
        </label>

        {fromLive && (
          <label className="field field--block">
            <span className="field__label">Capture filter</span>
            <select
              className="select"
              value={captureFilter}
              onChange={(e) => setCaptureFilter(e.target.value as SessionFilter)}
            >
              <option value="live">Live sessions</option>
              <option value="all">All sessions</option>
            </select>
          </label>
        )}

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>
            Save workspace
          </button>
        </div>
      </form>
    </div>
  );
}
