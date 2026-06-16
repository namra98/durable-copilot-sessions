import { randomUUID } from "node:crypto";
import os from "node:os";
import type {
  AppConfig,
  DiscoveredSession,
  LaunchResult,
  ManagedSession,
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
} from "./launch/index.js";
import { buildWindows } from "./snapshot/grouping.js";

/** A discovered session merged with the tool's managed metadata, for API/UI use. */
export type SessionView = DiscoveredSession & {
  title?: string;
  color?: string;
  group?: string;
  pinned?: boolean;
  hidden?: boolean;
  managed: boolean;
};

export type SessionFilter = "live" | "all";

/** Injectable dependencies (defaults wire to the real modules; tests inject fakes). */
export interface ManagerDeps {
  registry?: Registry;
  config?: AppConfig;
  discover?: (opts?: ListOptions) => DiscoveredSession[];
  getSession?: (id: string, opts?: ListOptions) => DiscoveredSession | undefined;
  resume?: typeof defaultResume;
  launchWindows?: typeof defaultLaunchWindows;
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

  constructor(deps: ManagerDeps = {}) {
    this.registry = deps.registry ?? createRegistry();
    this.config = deps.config ?? loadConfig();
    this.discover = deps.discover ?? defaultDiscover;
    this.getSessionFn = deps.getSession ?? defaultGetSession;
    this.resumeFn = deps.resume ?? defaultResume;
    this.launchWindowsFn = deps.launchWindows ?? defaultLaunchWindows;
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

  private toView(s: DiscoveredSession, managed: ManagedSession | undefined): SessionView {
    return {
      ...s,
      title: managed?.title,
      color: managed?.color,
      group: managed?.group,
      pinned: managed?.pinned,
      hidden: managed?.hidden,
      managed: managed !== undefined,
    };
  }

  /** List discovered sessions (merged with managed metadata). */
  listSessions(filter: SessionFilter = "all"): SessionView[] {
    const managed = this.managedMap();
    const sessions = this.discover();
    const filtered =
      filter === "live" ? sessions.filter((s) => s.liveness === "live") : sessions;
    return filtered.map((s) => this.toView(s, managed.get(s.id)));
  }

  /** Update tool-managed metadata for a session and return the merged view. */
  updateManaged(sessionId: string, patch: ManagedPatch): SessionView {
    const updated = this.registry.upsertManaged({ sessionId, ...patch });
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
    const title =
      opts.title ?? managed?.title ?? discovered?.name ?? opts.sessionId.slice(0, 8);
    const color = opts.color ?? managed?.color ?? "blue";
    return this.resumeFn({
      sessionId: opts.sessionId,
      cwd,
      title,
      color,
      window: opts.window ?? "new",
      copilotArgs: opts.copilotArgs,
      dryRun: opts.dryRun,
    });
  }

  /** Build the current live (or full) layout as windows + tabs. */
  captureLayout(filter: SessionFilter = "live"): WindowSpec[] {
    const managed = this.managedMap();
    const sessions = this.discover()
      .filter((s) => (filter === "live" ? s.liveness === "live" : true))
      .filter((s) => s.topLevel)
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
}
