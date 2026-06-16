import { randomUUID } from "node:crypto";
import os from "node:os";
import type {
  AppConfig,
  DiscoveredSession,
  GraphModel,
  LaunchResult,
  ManagedSession,
  Memory,
  MemoryKind,
  MemoryRecallPack,
  MemorySearchHit,
  ResumeOptions,
  WindowSpec,
  WindowTarget,
  Workspace,
} from "./types.js";
import { loadConfig } from "./config.js";
import {
  listSessions as defaultDiscover,
  getSession as defaultGetSession,
  type ListOptions,
} from "./discovery/index.js";
import { createRegistry, type Registry } from "./registry/index.js";
import {
  resumeSession as defaultResume,
  launchWindows as defaultLaunchWindows,
  launchNewSession as defaultLaunchNew,
} from "./launch/index.js";
import { buildWindows, annotateOpen, type OpenAnnotation } from "./snapshot/grouping.js";
import { buildGraph } from "./graph/index.js";
import { branchSession as defaultBranch, type ForkResult } from "./branch/index.js";
import { createMemoryStore, type MemoryStore } from "./memory/index.js";

/** A discovered session merged with the tool's managed metadata, for API/UI use. */
export type SessionView = DiscoveredSession & {
  title?: string;
  color?: string;
  group?: string;
  pinned?: boolean;
  hidden?: boolean;
  managed: boolean;
  /** "primary" = one open terminal's foreground session; "child" = co-located. */
  role?: "primary" | "child";
  /** Holder PID used to group this live session. */
  groupPid?: number;
  /** For a primary: how many child (subagent/background) sessions it holds. */
  childCount?: number;
};

export type SessionFilter = "open" | "live" | "all";

/** A session list plus the honest count of distinct open terminals. */
export interface SessionListResult {
  sessions: SessionView[];
  openCount: number;
}

/** Injectable dependencies (defaults wire to the real modules; tests inject fakes). */
export interface ManagerDeps {
  registry?: Registry;
  config?: AppConfig;
  discover?: (opts?: ListOptions) => DiscoveredSession[];
  getSession?: (id: string, opts?: ListOptions) => DiscoveredSession | undefined;
  resume?: typeof defaultResume;
  launchWindows?: typeof defaultLaunchWindows;
  launchNew?: typeof defaultLaunchNew;
  branch?: typeof defaultBranch;
  memoryStore?: MemoryStore;
}

/** Patch shape for tool-managed session metadata. */
export type ManagedPatch = Partial<Pick<ManagedSession, "title" | "color" | "group" | "pinned" | "hidden">>;

/**
 * The single façade the server and CLI use. Composes discovery (read Copilot
 * state), the durable registry (our own state), and the launcher (wt.exe).
 */
export class SessionManager {
  private readonly registry: Registry;
  private config: AppConfig;
  private readonly discover: (opts?: ListOptions) => DiscoveredSession[];
  private readonly getSessionFn: (id: string, opts?: ListOptions) => DiscoveredSession | undefined;
  private readonly resumeFn: typeof defaultResume;
  private readonly launchWindowsFn: typeof defaultLaunchWindows;
  private readonly launchNewFn: typeof defaultLaunchNew;
  private readonly branchFn: typeof defaultBranch;
  private memoryStore?: MemoryStore;

  constructor(deps: ManagerDeps = {}) {
    this.registry = deps.registry ?? createRegistry();
    this.config = deps.config ?? loadConfig();
    this.discover = deps.discover ?? defaultDiscover;
    this.getSessionFn = deps.getSession ?? defaultGetSession;
    this.resumeFn = deps.resume ?? defaultResume;
    this.launchWindowsFn = deps.launchWindows ?? defaultLaunchWindows;
    this.launchNewFn = deps.launchNew ?? defaultLaunchNew;
    this.branchFn = deps.branch ?? defaultBranch;
    this.memoryStore = deps.memoryStore;
  }

  getConfig(): AppConfig {
    return this.config;
  }

  setConfig(config: AppConfig): void {
    this.config = config;
  }

  private managedMap(): Map<string, ManagedSession> {
    const map = new Map<string, ManagedSession>();
    for (const m of this.registry.listManaged()) {
      map.set(m.sessionId, m);
    }
    return map;
  }

  private toView(
    s: DiscoveredSession,
    managed: ManagedSession | undefined,
    ann?: OpenAnnotation,
  ): SessionView {
    const role = ann?.roleById.get(s.id);
    return {
      ...s,
      title: managed?.title,
      color: managed?.color,
      group: managed?.group,
      pinned: managed?.pinned,
      hidden: managed?.hidden,
      managed: managed !== undefined,
      role,
      groupPid: ann?.groupPidById.get(s.id),
      childCount: role === "primary" ? ann?.childrenById.get(s.id)?.length ?? 0 : undefined,
    };
  }

  /** List sessions (merged with managed metadata) plus the open-terminal count. */
  listSessionsResult(filter: SessionFilter = "open"): SessionListResult {
    const managed = this.managedMap();
    const all = this.discover({ liveOnly: filter !== "all" });
    const ann = annotateOpen(all);
    let selected: DiscoveredSession[];
    if (filter === "open") {
      selected = all.filter((s) => ann.roleById.get(s.id) === "primary");
    } else if (filter === "live") {
      selected = all.filter((s) => s.liveness === "live");
    } else {
      selected = all;
    }
    return {
      sessions: selected.map((s) => this.toView(s, managed.get(s.id), ann)),
      openCount: ann.openCount,
    };
  }

  /** List discovered sessions (array form, e.g. for the CLI). */
  listSessions(filter: SessionFilter = "open"): SessionView[] {
    return this.listSessionsResult(filter).sessions;
  }

  /** Update tool-managed metadata for a session and return the merged view. */
  updateManaged(sessionId: string, patch: ManagedPatch): SessionView {
    // Only accept known, well-typed fields — never let request bodies inject a
    // different sessionId or arbitrary keys into the persisted record.
    const clean: ManagedPatch = {};
    if (typeof patch.title === "string") clean.title = patch.title;
    if (typeof patch.color === "string") clean.color = patch.color;
    if (typeof patch.group === "string") clean.group = patch.group;
    if (typeof patch.pinned === "boolean") clean.pinned = patch.pinned;
    if (typeof patch.hidden === "boolean") clean.hidden = patch.hidden;
    const updated = this.registry.upsertManaged({ ...clean, sessionId });
    const discovered = this.getSessionFn(sessionId);
    if (discovered) {
      return this.toView(discovered, updated);
    }
    // Session no longer discoverable; synthesize a minimal view from managed data.
    const placeholder: DiscoveredSession = {
      id: sessionId,
      cwd: "",
      cwdExists: false,
      liveness: "inactive",
      livePids: [],
      topLevel: true,
    };
    return this.toView(placeholder, updated);
  }

  /** Resume a single session in a new Windows Terminal tab. */
  resume(opts: ResumeOptions): LaunchResult {
    const managed = this.registry.getManaged(opts.sessionId);
    const discovered = this.getSessionFn(opts.sessionId);
    const cwd = opts.cwd ?? discovered?.cwd ?? os.homedir();
    const fallbacks = [opts.fallbacks ?? [], discovered?.gitRoot ?? []]
      .flat()
      .filter((d): d is string => typeof d === "string" && d.length > 0);
    const title =
      opts.title ?? managed?.title ?? discovered?.name ?? opts.sessionId.slice(0, 8);
    const color = opts.color ?? managed?.color ?? "blue";
    const result = this.resumeFn({
      sessionId: opts.sessionId,
      cwd,
      fallbacks,
      title,
      color,
      window: opts.window ?? "new",
      copilotArgs: opts.copilotArgs,
      dryRun: opts.dryRun,
    });
    // Warn (don't block) when the session already appears open in a live terminal.
    if (discovered?.liveness === "live" && discovered.livePids.length > 0) {
      result.warnings = [
        `Session "${title}" appears to already be open in a live terminal (pid ${discovered.livePids.join(", ")}); opening another tab may contend with it.`,
        ...result.warnings,
      ];
    }
    return result;
  }

  /** Resume several sessions together as one grouped Windows Terminal window. */
  resumeMany(
    sessionIds: string[],
    opts?: { window?: WindowTarget; dryRun?: boolean },
  ): LaunchResult {
    const managed = this.managedMap();
    const tabs = sessionIds.map((id) => {
      const d = this.getSessionFn(id);
      const m = managed.get(id);
      return {
        sessionId: id,
        title: m?.title ?? d?.name ?? id.slice(0, 8),
        color: m?.color ?? "blue",
        cwd: d?.cwd ?? os.homedir(),
      };
    });
    if (tabs.length === 0) {
      return { ok: false, tabsLaunched: 0, windowsOpened: 0, warnings: [], error: "No sessions to resume" };
    }
    const window: WindowSpec = { id: "w0", label: "resume", tabs };
    return this.launchWindowsFn([window], { window: opts?.window, dryRun: opts?.dryRun });
  }

  /** Build the current open layout (one tab per open terminal) as windows + tabs. */
  captureLayout(_filter: SessionFilter = "open"): WindowSpec[] {
    const managed = this.managedMap();
    const all = this.discover({ liveOnly: true });
    const ann = annotateOpen(all);
    const sessions = all
      .filter((s) => ann.roleById.get(s.id) === "primary")
      .filter((s) => !managed.get(s.id)?.hidden);
    return buildWindows(sessions, managed, this.config);
  }

  listWorkspaces(): Workspace[] {
    return this.registry.listWorkspaces();
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.registry.getWorkspace(id) ?? this.registry.listSnapshots().find((s) => s.id === id);
  }

  /** Create a saved workspace, optionally capturing the current live layout. */
  createWorkspace(input: {
    name: string;
    description?: string;
    fromLive?: boolean;
    filter?: SessionFilter;
    windows?: WindowSpec[];
  }): Workspace {
    const windows = input.fromLive
      ? this.captureLayout(input.filter ?? "live")
      : input.windows ?? [];
    return this.registry.createWorkspace({
      name: input.name,
      description: input.description,
      source: "manual",
      windows,
    });
  }

  deleteWorkspace(id: string): void {
    this.registry.deleteWorkspace(id);
  }

  /** Relaunch a saved workspace's windows + tabs. */
  restoreWorkspace(id: string, opts?: { window?: WindowTarget; dryRun?: boolean }): LaunchResult {
    const ws = this.getWorkspace(id);
    if (!ws) {
      return {
        ok: false,
        tabsLaunched: 0,
        windowsOpened: 0,
        warnings: [],
        error: `Workspace not found: ${id}`,
      };
    }
    return this.launchWindowsFn(ws.windows, { window: opts?.window, dryRun: opts?.dryRun });
  }

  /** Restore a workspace by name or id (CLI convenience). */
  restoreByNameOrId(nameOrId: string, opts?: { window?: WindowTarget; dryRun?: boolean }): LaunchResult {
    const byName = this.registry.findWorkspaceByName(nameOrId);
    const id = byName?.id ?? nameOrId;
    return this.restoreWorkspace(id, opts);
  }

  /** Capture a rolling auto-snapshot of the current live layout. */
  snapshot(): Workspace {
    const now = new Date().toISOString();
    const ws: Workspace = {
      id: randomUUID(),
      name: `autosnapshot-${now}`,
      source: "auto-snapshot",
      createdAt: now,
      updatedAt: now,
      windows: this.captureLayout("live"),
    };
    return this.registry.addSnapshot(ws, this.config.maxAutoSnapshots);
  }

  listSnapshots(): Workspace[] {
    return this.registry.listSnapshots();
  }

  latestSnapshot(): Workspace | undefined {
    return this.registry.latestSnapshot();
  }

  /* ---------------------------------------------------------------- *
   * Session graph
   * ---------------------------------------------------------------- */

  /** Build the session graph (nodes + fork/terminal edges) for a filter. */
  buildGraphModel(filter: SessionFilter = "live"): GraphModel {
    const managed = this.managedMap();
    const all = this.discover({ liveOnly: filter !== "all" });
    return buildGraph(all, managed, this.config);
  }

  /** Fork (branch) a session into a new one; optionally launch it. */
  fork(
    parentId: string,
    opts: { note?: string; launch?: boolean; color?: string; window?: WindowTarget } = {},
  ): { session: SessionView; fork: ForkResult; launch?: LaunchResult } {
    const result = this.branchFn(parentId, { note: opts.note });
    const discovered = this.getSessionFn(result.newSessionId);
    const managed = this.registry.getManaged(result.newSessionId);
    const base: DiscoveredSession = discovered ?? {
      id: result.newSessionId,
      cwd: "",
      cwdExists: false,
      liveness: "inactive",
      livePids: [],
      topLevel: true,
      branchOf: parentId,
      name: result.newSessionName,
    };
    const session = this.toView(base, managed);
    let launch: LaunchResult | undefined;
    if (opts.launch) {
      launch = this.resume({
        sessionId: result.newSessionId,
        title: result.newSessionName,
        color: opts.color,
        window: opts.window,
      });
    }
    return { session, fork: result, launch };
  }

  /** Launch a brand-new Copilot session in a Windows Terminal tab. */
  newSession(opts: {
    title: string;
    cwd: string;
    color?: string;
    prompt?: string;
    window?: WindowTarget;
  }): LaunchResult {
    return this.launchNewFn({
      title: opts.title,
      cwd: opts.cwd,
      color: opts.color,
      prompt: opts.prompt,
      window: opts.window,
    });
  }

  /* ---------------------------------------------------------------- *
   * Local memory / recall
   * ---------------------------------------------------------------- */

  private mem(): MemoryStore {
    if (!this.memoryStore) {
      this.memoryStore = createMemoryStore();
      // Build the index on first use if empty.
      try {
        if (this.memoryStore.count() === 0) {
          this.memoryStore.reindex();
        }
      } catch {
        // Recall is best-effort; ignore indexing failures.
      }
    }
    return this.memoryStore;
  }

  searchMemory(
    query: string,
    opts?: { repository?: string; kind?: MemoryKind; limit?: number },
  ): MemorySearchHit[] {
    return this.mem().search(query, opts);
  }

  relatedMemory(sessionId: string, opts?: { limit?: number }): Memory[] {
    return this.mem().related(sessionId, opts);
  }

  recallMemory(opts: { repository?: string; branch?: string; limit?: number }): MemoryRecallPack {
    return this.mem().recall(opts);
  }

  sessionMemory(sessionId: string): Memory[] {
    return this.mem().listForSession(sessionId);
  }

  reindexMemory(): { count: number } {
    return this.mem().reindex();
  }
}
