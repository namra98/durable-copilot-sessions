import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AppConfig, LaunchResult, TabSpec, WindowSpec, WindowTarget, Workspace } from "../core/types";
import * as api from "./api/client";
import type {
  CreateWorkspaceBody,
  SessionFilter,
  SessionPatch,
  SessionView,
} from "./api/client";
import { SessionCard } from "./components/SessionCard";
import { SkeletonGrid } from "./components/SkeletonCard";
import { Toolbar, type Grouping } from "./components/Toolbar";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { ToastStack, useToasts } from "./components/Toast";
import { GraphView } from "./components/GraphView";
import { MemoryPanel, type RelatedSeed } from "./components/MemoryPanel";
import { SessionDrawer } from "./components/SessionDrawer";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { InsightsView } from "./components/InsightsView";
import { SettingsView } from "./components/SettingsView";
import { SnapshotTimeline } from "./components/SnapshotTimeline";
import { SelectionBar } from "./components/SelectionBar";
import { resolveColor } from "./lib/colors";
import { triggerDownload } from "./lib/download";
import { useLocalStorage } from "./lib/useLocalStorage";
import { useTheme, useDensity } from "./lib/preferences";
import {
  applyQuickFilters,
  childrenOf,
  groupByRepo,
  searchSessions,
  sortSessions,
  type QuickFilter,
  type SortKey,
} from "./lib/sessions";

const AUTO_REFRESH_MS = 15000;
const SEARCH_DEBOUNCE_MS = 200;

interface SessionData {
  open: SessionView[];
  live: SessionView[];
  all: SessionView[];
  openCount: number;
}

const EMPTY_DATA: SessionData = { open: [], live: [], all: [], openCount: 0 };

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
  const { theme, toggleTheme } = useTheme();
  const { density, toggleDensity } = useDensity();

  const [filter, setFilter] = useState<SessionFilter>("open");
  const [primaryView, setPrimaryView] = useState<
    "sessions" | "graph" | "memory" | "insights" | "settings"
  >("sessions");
  const [relatedSeed, setRelatedSeed] = useState<RelatedSeed | null>(null);
  const [windowTarget, setWindowTarget] = useState<WindowTarget>("new");
  const [showHidden, setShowHidden] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Bulk-selection state for the session views.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const lastSelectedRef = useRef<string | null>(null);

  const [data, setData] = useState<SessionData>(EMPTY_DATA);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [version, setVersion] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const [globalBusy, setGlobalBusy] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  // Toolbar + view state (some persisted across reloads).
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useLocalStorage<SortKey>("dcs.sort", "recent");
  const [grouping, setGrouping] = useLocalStorage<Grouping>("dcs.grouping", "flat");
  const [quickFilters, setQuickFilters] = useState<QuickFilter[]>([]);
  const [expandedCards, setExpandedCards] = useLocalStorage<string[]>("dcs.expandedCards", []);
  const [collapsedGroups, setCollapsedGroups] = useLocalStorage<string[]>("dcs.collapsedGroups", []);

  const searchRef = useRef<HTMLInputElement>(null);

  // Debounce the search box.
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  // "/" focuses the search box (unless already typing in a field).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/") return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl/Cmd+K toggles the command palette from anywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // One-time: load config + server health for the header.
  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => undefined);
    api
      .getHealth()
      .then((h) => setVersion(h.version))
      .catch(() => undefined);
  }, []);

  const loadAll = useCallback(async (): Promise<void> => {
    const [open, live, all, ws] = await Promise.all([
      api.listSessions("open"),
      api.listSessions("live"),
      api.listSessions("all"),
      api.listWorkspaces(),
    ]);
    setData({ open: open.sessions, live: live.sessions, all: all.sessions, openCount: open.openCount });
    setWorkspaces(ws);
  }, []);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadAll()
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAll]);

  // Silent auto-refresh.
  useEffect(() => {
    const id = window.setInterval(() => {
      loadAll().catch(() => undefined);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [loadAll]);

  // Reflect the honest open count in the document title.
  useEffect(() => {
    document.title = `${data.openCount} open · Durable Copilot Sessions`;
  }, [data.openCount]);

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
      await loadAll();
      push("info", "Refreshed.");
    } catch (err) {
      setError(errorMessage(err));
      push("error", `Refresh failed: ${errorMessage(err)}`);
    }
  }, [loadAll, push]);

  const patchEverywhere = useCallback(
    (id: string, updater: (s: SessionView) => SessionView) => {
      setData((curr) => ({
        ...curr,
        open: curr.open.map((s) => (s.id === id ? updater(s) : s)),
        live: curr.live.map((s) => (s.id === id ? updater(s) : s)),
        all: curr.all.map((s) => (s.id === id ? updater(s) : s)),
      }));
    },
    [],
  );

  const handlePatch = useCallback(
    async (id: string, patch: SessionPatch) => {
      setBusy(id, true);
      patchEverywhere(id, (s) => ({ ...s, ...patch, managed: true }));
      try {
        const updated = await api.patchSession(id, patch);
        patchEverywhere(id, (s) => ({ ...s, ...updated }));
      } catch (err) {
        push("error", `Update failed: ${errorMessage(err)}`);
        loadAll().catch(() => undefined);
      } finally {
        setBusy(id, false);
      }
    },
    [loadAll, patchEverywhere, push, setBusy],
  );

  // Hide a session, surfacing an Undo affordance that re-shows it.
  const handleHide = useCallback(
    (session: SessionView) => {
      const next = !session.hidden;
      void handlePatch(session.id, { hidden: next });
      if (next) {
        const label = session.title || session.name || session.id;
        push("info", `Hid “${label}”.`, {
          action: { label: "Undo", onClick: () => void handlePatch(session.id, { hidden: false }) },
        });
      }
    },
    [handlePatch, push],
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

  const handleResumeGroup = useCallback(
    async (label: string, ids: string[]) => {
      if (ids.length === 0) return;
      setGlobalBusy(true);
      try {
        const result = await api.resumeBatch(ids, windowTarget);
        reportLaunch(result, `Resumed ${ids.length} from “${label}”`);
      } catch (err) {
        push("error", `Resume all failed: ${errorMessage(err)}`);
      } finally {
        setGlobalBusy(false);
      }
    },
    [windowTarget, push, reportLaunch],
  );

  const handleRestore = useCallback(
    async (ws: Workspace) => {
      setGlobalBusy(true);
      const tabCount = ws.windows.reduce((sum, w) => sum + w.tabs.length, 0);
      const progressId =
        tabCount > 1
          ? push("progress", `Restoring “${ws.name}” · ${tabCount} tabs…`, { progress: true })
          : null;
      try {
        const result = await api.restoreWorkspace(ws.id, { window: windowTarget });
        if (progressId !== null) dismiss(progressId);
        reportLaunch(result, `Restored “${ws.name}”`);
      } catch (err) {
        if (progressId !== null) dismiss(progressId);
        push("error", `Restore failed: ${errorMessage(err)}`);
      } finally {
        setGlobalBusy(false);
      }
    },
    [windowTarget, push, dismiss, reportLaunch],
  );

  const handleDelete = useCallback(
    async (ws: Workspace) => {
      if (!window.confirm(`Delete workspace “${ws.name}”?`)) return;
      setGlobalBusy(true);
      try {
        await api.deleteWorkspace(ws.id);
        setWorkspaces((curr) => curr.filter((w) => w.id !== ws.id));
        const restore = async () => {
          try {
            const recreated = await api.createWorkspace({
              name: ws.name,
              description: ws.description,
              windows: ws.windows,
            });
            setWorkspaces((curr) => [recreated, ...curr.filter((w) => w.id !== recreated.id)]);
            push("success", `Restored “${ws.name}”.`);
          } catch (err) {
            push("error", `Undo failed: ${errorMessage(err)}`);
          }
        };
        push("info", `Deleted “${ws.name}”.`, {
          action: { label: "Undo", onClick: () => void restore() },
        });
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

  const handleExportWorkspaces = useCallback(async () => {
    setGlobalBusy(true);
    try {
      const json = await api.exportWorkspaces();
      const stamp = new Date().toISOString().slice(0, 10);
      triggerDownload(`workspaces-${stamp}.json`, json, "application/json");
      push("success", "Exported workspaces.");
    } catch (err) {
      push("error", `Export failed: ${errorMessage(err)}`);
    } finally {
      setGlobalBusy(false);
    }
  }, [push]);

  const handleImportWorkspaces = useCallback(
    async (json: string) => {
      setGlobalBusy(true);
      try {
        const imported = await api.importWorkspaces(json, true);
        await loadAll();
        push("success", `Imported ${imported.length} workspace${imported.length === 1 ? "" : "s"}.`);
      } catch (err) {
        push("error", `Import failed: ${errorMessage(err)}`);
      } finally {
        setGlobalBusy(false);
      }
    },
    [loadAll, push],
  );

  const [showImportDialog, setShowImportDialog] = useState(false);

  const toggleExpand = useCallback(
    (id: string) => {
      setExpandedCards((curr) =>
        curr.includes(id) ? curr.filter((x) => x !== id) : [...curr, id],
      );
    },
    [setExpandedCards],
  );

  const toggleGroup = useCallback(
    (key: string) => {
      setCollapsedGroups((curr) =>
        curr.includes(key) ? curr.filter((x) => x !== key) : [...curr, key],
      );
    },
    [setCollapsedGroups],
  );

  const toggleQuick = useCallback((chip: QuickFilter) => {
    setQuickFilters((curr) =>
      curr.includes(chip) ? curr.filter((c) => c !== chip) : [...curr, chip],
    );
  }, []);

  const selectSessionsTab = useCallback((next: SessionFilter) => {
    setPrimaryView("sessions");
    setFilter(next);
  }, []);

  const showRelatedMemory = useCallback((sessionId: string, label: string) => {
    setRelatedSeed({ sessionId, label });
    setPrimaryView("memory");
  }, []);

  const openDrawer = useCallback((id: string) => setDrawerId(id), []);

  // Discrete commands surfaced in the command palette.
  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      { id: "view-open", label: "Open: Open terminals", hint: "View", run: () => selectSessionsTab("open") },
      { id: "view-live", label: "Open: Live sessions", hint: "View", run: () => selectSessionsTab("live") },
      { id: "view-all", label: "Open: All sessions", hint: "View", run: () => selectSessionsTab("all") },
      { id: "view-graph", label: "Open Graph", hint: "View", run: () => setPrimaryView("graph") },
      { id: "view-memory", label: "Open Memory", hint: "View", run: () => setPrimaryView("memory") },
      { id: "view-insights", label: "Open Insights", hint: "View", run: () => setPrimaryView("insights") },
      { id: "view-settings", label: "Open Settings", hint: "View", run: () => setPrimaryView("settings") },
      { id: "snapshot", label: "Snapshot now", hint: "Action", run: () => void handleSnapshot() },
      {
        id: "export-workspaces",
        label: "Export workspaces",
        hint: "Action",
        run: () => void handleExportWorkspaces(),
      },
      {
        id: "reindex",
        label: "Reindex memories",
        hint: "Action",
        run: () => {
          api
            .reindexMemory()
            .then((count) => push("success", `Reindexed ${count} memor${count === 1 ? "y" : "ies"}.`))
            .catch((err) => push("error", `Reindex failed: ${errorMessage(err)}`));
        },
      },
      {
        id: "toggle-theme",
        label: `Toggle theme (now ${theme})`,
        hint: "Action",
        run: toggleTheme,
      },
      {
        id: "toggle-density",
        label: `Toggle density (now ${density})`,
        hint: "Action",
        run: toggleDensity,
      },
      {
        id: "save-workspace",
        label: "Save current as workspace",
        hint: "Action",
        run: () => setShowSaveDialog(true),
      },
    ],
    [selectSessionsTab, handleSnapshot, handleExportWorkspaces, push, theme, toggleTheme, density, toggleDensity],
  );

  const activeList = filter === "open" ? data.open : filter === "live" ? data.live : data.all;

  const hiddenCount = useMemo(() => activeList.filter((s) => s.hidden).length, [activeList]);
  const archivedCount = useMemo(() => activeList.filter((s) => s.archived).length, [activeList]);

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const s of activeList) for (const t of s.tags ?? []) set.add(t);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [activeList]);

  const visibleSessions = useMemo(() => {
    let list = showArchived ? activeList : activeList.filter((s) => !s.archived);
    list = showHidden ? list : list.filter((s) => !s.hidden);
    if (tagFilter) list = list.filter((s) => (s.tags ?? []).includes(tagFilter));
    const searched = searchSessions(list, search);
    const filtered = applyQuickFilters(searched, quickFilters);
    return sortSessions(filtered, sort);
  }, [activeList, showArchived, showHidden, tagFilter, search, quickFilters, sort]);

  const groups = useMemo(
    () => (grouping === "by-repo" ? groupByRepo(visibleSessions) : []),
    [grouping, visibleSessions],
  );

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectionActive = selectedIds.length > 0;

  const toggleSelect = useCallback(
    (id: string, shiftKey: boolean) => {
      setSelectedIds((curr) => {
        const order = visibleSessions.map((s) => s.id);
        if (shiftKey && lastSelectedRef.current) {
          const from = order.indexOf(lastSelectedRef.current);
          const to = order.indexOf(id);
          if (from !== -1 && to !== -1) {
            const [lo, hi] = from < to ? [from, to] : [to, from];
            const range = order.slice(lo, hi + 1);
            const merged = new Set(curr);
            for (const rid of range) merged.add(rid);
            lastSelectedRef.current = id;
            return Array.from(merged);
          }
        }
        lastSelectedRef.current = id;
        return curr.includes(id) ? curr.filter((x) => x !== id) : [...curr, id];
      });
    },
    [visibleSessions],
  );

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    lastSelectedRef.current = null;
  }, []);

  const bulkPatch = useCallback(
    async (patch: SessionPatch, label: string) => {
      const ids = selectedIds.slice();
      if (ids.length === 0) return;
      setGlobalBusy(true);
      const progressId = push("progress", `${label} ${ids.length} session${ids.length === 1 ? "" : "s"}…`, {
        progress: true,
      });
      try {
        await Promise.all(ids.map((id) => api.patchSession(id, patch)));
        ids.forEach((id) => patchEverywhere(id, (s) => ({ ...s, ...patch, managed: true })));
        dismiss(progressId);
        push("success", `${label} ${ids.length} session${ids.length === 1 ? "" : "s"}.`);
      } catch (err) {
        dismiss(progressId);
        push("error", `${label} failed: ${errorMessage(err)}`);
        loadAll().catch(() => undefined);
      } finally {
        setGlobalBusy(false);
      }
    },
    [selectedIds, push, dismiss, patchEverywhere, loadAll],
  );

  const bulkResume = useCallback(async () => {
    const ids = selectedIds.slice();
    if (ids.length === 0) return;
    setGlobalBusy(true);
    const progressId = push("progress", `Resuming ${ids.length} session${ids.length === 1 ? "" : "s"}…`, {
      progress: true,
    });
    try {
      const result = await api.resumeBatch(ids, windowTarget);
      dismiss(progressId);
      reportLaunch(result, `Resumed ${ids.length} selected`);
    } catch (err) {
      dismiss(progressId);
      push("error", `Resume all failed: ${errorMessage(err)}`);
    } finally {
      setGlobalBusy(false);
    }
  }, [selectedIds, windowTarget, push, dismiss, reportLaunch]);

  const bulkAddTag = useCallback(() => {
    const tag = window.prompt("Add tag to the selected sessions:");
    const trimmed = tag?.trim();
    if (!trimmed) return;
    const ids = selectedIds.slice();
    setGlobalBusy(true);
    const progressId = push("progress", `Tagging ${ids.length} session${ids.length === 1 ? "" : "s"}…`, {
      progress: true,
    });
    Promise.all(
      ids.map((id) => {
        const current = activeList.find((s) => s.id === id);
        const existing = current?.tags ?? [];
        const next = existing.includes(trimmed) ? existing : [...existing, trimmed];
        return api.patchSession(id, { tags: next });
      }),
    )
      .then(() => {
        ids.forEach((id) =>
          patchEverywhere(id, (s) => ({
            ...s,
            tags: (s.tags ?? []).includes(trimmed) ? s.tags : [...(s.tags ?? []), trimmed],
            managed: true,
          })),
        );
        dismiss(progressId);
        push("success", `Tagged ${ids.length} with “${trimmed}”.`);
      })
      .catch((err) => {
        dismiss(progressId);
        push("error", `Tagging failed: ${errorMessage(err)}`);
        loadAll().catch(() => undefined);
      })
      .finally(() => setGlobalBusy(false));
  }, [selectedIds, activeList, push, dismiss, patchEverywhere, loadAll]);

  const bulkSaveWorkspace = useCallback(async () => {
    const ids = selectedIds.slice();
    if (ids.length === 0) return;
    const name = window.prompt("Save the selected sessions as a workspace named:");
    const trimmed = name?.trim();
    if (!trimmed) return;
    const chosen = ids
      .map((id) => activeList.find((s) => s.id === id))
      .filter((s): s is SessionView => Boolean(s));
    const tabs: TabSpec[] = chosen.map((s) => ({
      sessionId: s.id,
      title: s.title ?? s.name ?? s.id,
      color: s.color ?? resolveColor(s),
      cwd: s.cwd,
    }));
    const windows: WindowSpec[] = [{ id: "w1", label: trimmed, tabs }];
    setGlobalBusy(true);
    try {
      const ws = await api.createWorkspace({ name: trimmed, windows });
      setWorkspaces((curr) => [ws, ...curr.filter((w) => w.id !== ws.id)]);
      push("success", `Saved workspace “${ws.name}” with ${tabs.length} tab${tabs.length === 1 ? "" : "s"}.`);
    } catch (err) {
      push("error", `Save failed: ${errorMessage(err)}`);
    } finally {
      setGlobalBusy(false);
    }
  }, [selectedIds, activeList, push]);

  const renderCard = (s: SessionView) => (
    <SessionCard
      key={s.id}
      session={s}
      busy={Boolean(busyIds[s.id]) || globalBusy}
      expanded={expandedCards.includes(s.id)}
      childSessions={childrenOf(s, data.live)}
      childrenLoading={loading}
      onToggleExpand={toggleExpand}
      onResume={handleResume}
      onPatch={handlePatch}
      onRelated={(s) => showRelatedMemory(s.id, s.title || s.name || s.id)}
      onHide={handleHide}
      onOpen={(s) => openDrawer(s.id)}
      selected={selectedSet.has(s.id)}
      selectionActive={selectionActive}
      onToggleSelect={toggleSelect}
    />
  );

  const isEmpty = !loading && visibleSessions.length === 0;
  const filtersActive = search.trim() !== "" || quickFilters.length > 0;

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
            className="btn btn--icon"
            aria-label="Open command palette"
            title="Command palette (Ctrl/Cmd+K)"
            onClick={() => setPaletteOpen(true)}
          >
            ⌘K
          </button>
          <button
            type="button"
            className="btn btn--icon"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            aria-pressed={theme === "light"}
            title={`Theme: ${theme} (click to switch)`}
            onClick={toggleTheme}
          >
            {theme === "dark" ? "☾" : "☀"}
          </button>
          <button
            type="button"
            className="btn btn--icon"
            aria-label={`Switch to ${density === "comfortable" ? "compact" : "comfortable"} density`}
            aria-pressed={density === "compact"}
            title={`Density: ${density} (click to switch)`}
            onClick={toggleDensity}
          >
            {density === "comfortable" ? "▤" : "▦"}
          </button>

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

      <nav className="tabs" role="tablist" aria-label="Session view">
        <button
          type="button"
          role="tab"
          aria-selected={primaryView === "sessions" && filter === "open"}
          className={`tab${primaryView === "sessions" && filter === "open" ? " tab--on" : ""}`}
          onClick={() => selectSessionsTab("open")}
        >
          <span className="tab__dot" aria-hidden="true" />
          Open
          <span className="tab__count tab__count--accent">{data.openCount}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={primaryView === "sessions" && filter === "live"}
          className={`tab${primaryView === "sessions" && filter === "live" ? " tab--on" : ""}`}
          onClick={() => selectSessionsTab("live")}
        >
          Live
          <span className="tab__count">{data.live.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={primaryView === "sessions" && filter === "all"}
          className={`tab${primaryView === "sessions" && filter === "all" ? " tab--on" : ""}`}
          onClick={() => selectSessionsTab("all")}
        >
          All
          <span className="tab__count">{data.all.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={primaryView === "graph"}
          className={`tab${primaryView === "graph" ? " tab--on" : ""}`}
          onClick={() => setPrimaryView("graph")}
        >
          Graph
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={primaryView === "memory"}
          className={`tab${primaryView === "memory" ? " tab--on" : ""}`}
          onClick={() => setPrimaryView("memory")}
        >
          Memory
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={primaryView === "insights"}
          className={`tab${primaryView === "insights" ? " tab--on" : ""}`}
          onClick={() => setPrimaryView("insights")}
        >
          Insights
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={primaryView === "settings"}
          className={`tab${primaryView === "settings" ? " tab--on" : ""}`}
          onClick={() => setPrimaryView("settings")}
        >
          Settings
        </button>
      </nav>

      {error && primaryView === "sessions" && (
        <div className="banner banner--error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn--ghost" onClick={manualRefresh}>
            Retry
          </button>
        </div>
      )}

      {primaryView === "graph" ? (
        <main className="content content--graph">
          <GraphView
            initialFilter={filter}
            windowTarget={windowTarget}
            push={push}
            onShowRelated={showRelatedMemory}
            onOpenSession={openDrawer}
          />
        </main>
      ) : primaryView === "memory" ? (
        <main className="content content--memory">
          <MemoryPanel
            windowTarget={windowTarget}
            push={push}
            relatedSeed={relatedSeed}
            onClearRelated={() => setRelatedSeed(null)}
          />
        </main>
      ) : primaryView === "insights" ? (
        <main className="content content--single">
          <InsightsView push={push} />
        </main>
      ) : primaryView === "settings" ? (
        <main className="content content--single">
          <SettingsView push={push} onSaved={setConfig} />
        </main>
      ) : (
        <main className="content">
        <section className="panel">
          <div className="panel__head">
            <h2>
              {filter === "open" ? "Open terminals" : filter === "live" ? "Live sessions" : "All sessions"}{" "}
              <span className="count">{visibleSessions.length}</span>
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

          <Toolbar
            search={searchInput}
            onSearch={setSearchInput}
            sort={sort}
            onSort={setSort}
            grouping={grouping}
            onGrouping={setGrouping}
            quickFilters={quickFilters}
            onToggleQuick={toggleQuick}
            searchRef={searchRef}
            tags={availableTags}
            tagFilter={tagFilter}
            onTagFilter={setTagFilter}
            showArchived={showArchived}
            onShowArchived={setShowArchived}
            archivedCount={archivedCount}
          />

          {loading ? (
            <SkeletonGrid />
          ) : isEmpty ? (
            <EmptyState
              filter={filter}
              filtersActive={filtersActive}
              onClear={() => {
                setSearchInput("");
                setQuickFilters([]);
              }}
              onRefresh={manualRefresh}
            />
          ) : grouping === "by-repo" ? (
            <div className="groups">
              {groups.map((g) => {
                const collapsed = collapsedGroups.includes(g.key);
                return (
                  <section className="group" key={g.key}>
                    <header className="group__head">
                      <button
                        type="button"
                        className="group__toggle"
                        aria-expanded={!collapsed}
                        onClick={() => toggleGroup(g.key)}
                      >
                        <span
                          className={`disclosure__caret${collapsed ? "" : " disclosure__caret--open"}`}
                          aria-hidden="true"
                        >
                          ▸
                        </span>
                        <span className="group__name" title={g.label}>{g.label}</span>
                        <span className="count">{g.sessions.length}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost group__resume-all"
                        disabled={globalBusy}
                        onClick={() => handleResumeGroup(g.label, g.sessions.map((s) => s.id))}
                      >
                        Resume all
                      </button>
                    </header>
                    {!collapsed && <div className={`grid grid--${density}`}>{g.sessions.map(renderCard)}</div>}
                  </section>
                );
              })}
            </div>
          ) : (
            <div className={`grid grid--${density}`}>{visibleSessions.map(renderCard)}</div>
          )}
        </section>

        <section className="panel">
          <div className="panel__head">
            <h2>
              Workspaces <span className="count">{workspaces.length}</span>
            </h2>
            <div className="panel__head-actions">
              <button
                type="button"
                className="btn btn--ghost"
                disabled={globalBusy || workspaces.length === 0}
                onClick={() => void handleExportWorkspaces()}
              >
                Export…
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={globalBusy}
                onClick={() => setShowImportDialog(true)}
              >
                Import…
              </button>
            </div>
          </div>
          <WorkspacePanel
            workspaces={workspaces}
            busy={globalBusy}
            onRestore={handleRestore}
            onDelete={handleDelete}
          />
        </section>

        <SnapshotTimeline
          windowTarget={windowTarget}
          busy={globalBusy}
          push={push}
          onRestore={handleRestore}
          onPromoted={() => loadAll().catch(() => undefined)}
        />
      </main>
      )}

      {showImportDialog && (
        <ImportWorkspacesDialog
          busy={globalBusy}
          onCancel={() => setShowImportDialog(false)}
          onImport={async (json) => {
            await handleImportWorkspaces(json);
            setShowImportDialog(false);
          }}
        />
      )}

      {showSaveDialog && (
        <SaveWorkspaceDialog
          defaultFilter={filter}
          busy={globalBusy}
          onCancel={() => setShowSaveDialog(false)}
          onSave={handleCreateWorkspace}
        />
      )}

      {drawerId && (
        <SessionDrawer
          id={drawerId}
          windowTarget={windowTarget}
          push={push}
          onClose={() => setDrawerId(null)}
          onOpen={openDrawer}
          onResume={handleResume}
          onPatch={handlePatch}
          onShowRelated={(sessionId, label) => {
            setDrawerId(null);
            showRelatedMemory(sessionId, label);
          }}
          onReload={() => loadAll().catch(() => undefined)}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          sessions={data.all}
          workspaces={workspaces}
          actions={paletteActions}
          onClose={() => setPaletteOpen(false)}
          onOpenSession={openDrawer}
          onResumeSession={handleResume}
          onRestoreWorkspace={handleRestore}
        />
      )}

      {primaryView === "sessions" && selectionActive && (
        <SelectionBar
          count={selectedIds.length}
          busy={globalBusy}
          onResumeAll={() => void bulkResume()}
          onSetColor={(stored) => void bulkPatch({ color: stored }, "Colored")}
          onPin={() => void bulkPatch({ pinned: true }, "Pinned")}
          onHide={() => void bulkPatch({ hidden: true }, "Hid")}
          onAddTag={bulkAddTag}
          onArchive={() => void bulkPatch({ archived: true }, "Archived")}
          onSaveWorkspace={() => void bulkSaveWorkspace()}
          onClear={clearSelection}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

interface EmptyStateProps {
  filter: SessionFilter;
  filtersActive: boolean;
  onClear: () => void;
  onRefresh: () => void;
}

function EmptyState({ filter, filtersActive, onClear, onRefresh }: EmptyStateProps) {
  if (filtersActive) {
    return (
      <div className="empty empty--cta">
        <p className="empty__title">No sessions match your filters</p>
        <p className="empty__sub">Try a different search or clear the active filters.</p>
        <button type="button" className="btn btn--primary" onClick={onClear}>
          Clear filters
        </button>
      </div>
    );
  }
  const noun = filter === "open" ? "open terminals" : filter === "live" ? "live sessions" : "sessions";
  return (
    <div className="empty empty--cta">
      <p className="empty__title">No {noun} found</p>
      <p className="empty__sub">
        Start a Copilot session in a terminal, or check again in a moment.
      </p>
      <button type="button" className="btn btn--primary" onClick={onRefresh}>
        Refresh
      </button>
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
          Capture the current open layout
        </label>

        {fromLive && (
          <label className="field field--block">
            <span className="field__label">Capture filter</span>
            <select
              className="select"
              value={captureFilter}
              onChange={(e) => setCaptureFilter(e.target.value as SessionFilter)}
            >
              <option value="open">Open terminals</option>
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

interface ImportDialogProps {
  busy: boolean;
  onCancel: () => void;
  onImport: (json: string) => void | Promise<void>;
}

function ImportWorkspacesDialog({ busy, onCancel, onImport }: ImportDialogProps) {
  const [json, setJson] = useState("");

  function onFile(e: FormEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setJson(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = json.trim();
    if (!trimmed) return;
    void onImport(trimmed);
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Import workspaces"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h3 className="modal__title">Import workspaces</h3>

        <label className="field field--block">
          <span className="field__label">Choose a JSON file</span>
          <input className="input" type="file" accept="application/json,.json" onChange={onFile} />
        </label>

        <label className="field field--block">
          <span className="field__label">…or paste exported JSON</span>
          <textarea
            className="input"
            rows={6}
            value={json}
            placeholder='{"workspaces":[…]}'
            onChange={(e) => setJson(e.target.value)}
          />
        </label>

        <p className="modal__hint">Imported workspaces are assigned fresh ids and won’t overwrite existing ones.</p>

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy || !json.trim()}>
            Import
          </button>
        </div>
      </form>
    </div>
  );
}
