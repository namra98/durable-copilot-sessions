import process from "node:process";
import { SessionManager } from "../core/manager.js";
import type { LaunchResult, MemorySearchHit, Workspace } from "../core/types.js";
import {
  clampStateSelection,
  filterVisibleData,
  handleTuiInput,
  primeVisibleDataCache,
  renderTui,
  sessionTitle,
  type TuiData,
  type TuiCommand,
  type TuiRefreshScope,
  type TuiState,
  type TuiStatus,
} from "./tuiModel.js";

export interface TuiInput {
  isTTY?: boolean;
  isRaw: boolean;
  setRawMode(mode: boolean): void;
  resume(): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  off(event: "data", listener: (chunk: Buffer | string) => void): this;
}

export interface TuiOutput {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(chunk: string): unknown;
  on(event: "resize", listener: () => void): this;
  off(event: "resize", listener: () => void): this;
}

export interface TuiIo {
  stdin: TuiInput;
  stdout: TuiOutput;
}

export interface TuiManager {
  listSessionsResult: SessionManager["listSessionsResult"];
  listWorkspaces: SessionManager["listWorkspaces"];
  listSnapshots: SessionManager["listSnapshots"];
  resume: SessionManager["resume"];
  restoreWorkspace: SessionManager["restoreWorkspace"];
  snapshot: SessionManager["snapshot"];
  createWorkspace: SessionManager["createWorkspace"];
  searchMemory: SessionManager["searchMemory"];
}

export async function runTui(manager: TuiManager = new SessionManager(), io: TuiIo = process): Promise<void> {
  if (!io.stdin.isTTY || !io.stdout.isTTY || typeof io.stdin.setRawMode !== "function") {
    throw new Error("The TUI requires an interactive terminal.");
  }

  const app = new TuiApp(manager, io);
  await app.start();
}

function defaultState(): TuiState {
  return {
    pane: "sessions",
    filter: "open",
    theme: "midnight",
    query: "",
    mode: "normal",
    input: "",
    sessionIndex: 0,
    workspaceIndex: 0,
    memoryIndex: 0,
    status: { kind: "info", message: "ready" },
  };
}

function sortWorkspaces(workspaces: Workspace[]): Workspace[] {
  return [...workspaces].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function defaultWorkspaceName(): string {
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  return `tui-layout-${stamp}`;
}

function summarizeLaunch(action: string, result: LaunchResult): TuiStatus {
  if (!result.ok) {
    return {
      kind: "error",
      message: `${action} failed: ${result.error ?? "unknown error"}`,
    };
  }
  const warning = result.warnings.length > 0 ? `; ${result.warnings.length} warning(s)` : "";
  return {
    kind: "success",
    message: `${action}: opened ${result.tabsLaunched} tab(s) in ${result.windowsOpened} window(s)${warning}`,
  };
}

function errorStatus(error: unknown): TuiStatus {
  return {
    kind: "error",
    message: error instanceof Error ? error.message : String(error),
  };
}

const DISCOVERY_CACHE_TTL_MS = 1500;
const RESIZE_RENDER_DEBOUNCE_MS = 16;
const MEMORY_SEARCH_DEBOUNCE_MS = 150;
const MEMORY_PREWARM_DELAY_MS = 500;

class TuiApp {
  private readonly manager: TuiManager;
  private readonly stdin: TuiInput;
  private readonly stdout: TuiOutput;
  private state: TuiState;
  private data: TuiData;
  private stopped: boolean;
  private originalRawMode: boolean;
  private resolveStop?: () => void;
  private memorySearchTimer?: ReturnType<typeof setTimeout>;
  private memoryPrewarmTimer?: ReturnType<typeof setTimeout>;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private readonly sessionCache: Map<TuiState["filter"], { at: number; result: ReturnType<TuiManager["listSessionsResult"]> }>;
  private layoutCache?: { at: number; workspaces: Workspace[] };
  private lastFrameLines?: string[];
  private readonly onData: (chunk: Buffer | string) => void;
  private readonly onResize: () => void;
  private readonly onSigint: () => void;

  constructor(manager: TuiManager, io: TuiIo) {
    this.manager = manager;
    this.stdin = io.stdin;
    this.stdout = io.stdout;
    this.state = defaultState();
    this.data = { sessions: { sessions: [], openCount: 0 }, workspaces: [], memoryHits: [] };
    this.stopped = false;
    this.originalRawMode = this.stdin.isRaw;
    this.sessionCache = new Map();
    this.onData = (chunk) => {
      void this.handleInput(chunk.toString()).catch((error: unknown) => {
        this.state = { ...this.state, status: errorStatus(error) };
        this.render();
      });
    };
    this.onResize = () => this.scheduleRender();
    this.onSigint = () => this.stop();
  }

  async start(): Promise<void> {
    this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.on("data", this.onData);
    this.stdout.on("resize", this.onResize);
    process.once("SIGINT", this.onSigint);
    try {
      this.stdout.write("\x1b[?1049h\x1b[?25l");
      this.refresh({ kind: "info", message: "loaded sessions and workspaces" }, "all", true);
      this.render();
      this.scheduleMemoryPrewarm();

      await new Promise<void>((resolve) => {
        this.resolveStop = resolve;
      });
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stdin.off("data", this.onData);
    this.stdout.off("resize", this.onResize);
    process.off("SIGINT", this.onSigint);
    this.clearMemorySearchTimer();
    this.clearMemoryPrewarmTimer();
    this.clearRenderTimer();
    this.stdin.setRawMode(this.originalRawMode);
    this.stdout.write("\x1b[?25h\x1b[?1049l");
    this.resolveStop?.();
  }

  private refresh(status?: TuiStatus, scope: TuiRefreshScope = "all", force = false): void {
    const reloadSessions = scope === "all" || scope === "sessions";
    const reloadLayouts = scope === "all" || scope === "layouts";
    const memoryHits = scope === "all" ? this.searchMemory() : this.data.memoryHits;
    this.setData({
      sessions: reloadSessions ? this.loadSessions(force) : this.data.sessions,
      workspaces: reloadLayouts ? this.loadLayouts(force) : this.data.workspaces,
      memoryHits,
    });
    this.state = clampStateSelection(
      {
        ...this.state,
        status: status ?? this.state.status,
      },
      filterVisibleData(this.data, this.state.query),
    );
  }

  private render(): void {
    this.clearRenderTimer();
    const columns = this.stdout.columns ?? 100;
    const rows = this.stdout.rows ?? 30;
    const frame = renderTui(this.state, this.data, { columns, rows, color: true });
    this.writeFrame(frame, rows);
  }

  private async handleInput(input: string): Promise<void> {
    const result = handleTuiInput(this.state, this.data, input, {
      defaultWorkspaceName: defaultWorkspaceName(),
    });
    this.state = result.state;
    if (result.command && this.runCommand(result.command)) {
      return;
    }
    this.render();
  }

  private runCommand(command: TuiCommand): boolean {
    if (command.kind === "quit") {
      this.stop();
      return true;
    }
    if (command.kind === "refresh") {
      this.refresh(command.status, command.scope, command.scope === "all");
    } else if (command.kind === "search") {
      this.search(command.query, command.status, command.immediate);
    } else if (command.kind === "snapshot") {
      const snapshot = this.manager.snapshot();
      this.layoutCache = undefined;
      this.refresh({ kind: "success", message: `snapshot saved: ${snapshot.name}` }, "layouts", true);
    } else if (command.kind === "activate") {
      this.activateSelection();
    } else {
      this.saveWorkspace(command.name);
    }
    return false;
  }

  private activateSelection(): void {
    const visible = filterVisibleData(this.data, this.state.query);
    if (this.state.pane === "sessions") {
      const session = visible.sessions[this.state.sessionIndex];
      if (!session) {
        this.state = { ...this.state, status: { kind: "error", message: "no session selected" } };
        return;
      }
      const result = this.manager.resume({ sessionId: session.id, window: "new" });
      this.state = { ...this.state, status: summarizeLaunch(`resumed ${sessionTitle(session)}`, result) };
    } else if (this.state.pane === "workspaces") {
      const workspace = visible.workspaces[this.state.workspaceIndex];
      if (!workspace) {
        this.state = { ...this.state, status: { kind: "error", message: "no workspace selected" } };
        return;
      }
      const result = this.manager.restoreWorkspace(workspace.id, { window: "new" });
      this.state = { ...this.state, status: summarizeLaunch(`restored ${workspace.name}`, result) };
    } else {
      const hit = visible.memoryHits[this.state.memoryIndex];
      if (!hit) {
        this.state = { ...this.state, status: { kind: "error", message: "no memory selected" } };
        return;
      }
      const result = this.manager.resume({ sessionId: hit.memory.sessionId, window: "new" });
      this.state = {
        ...this.state,
        status: summarizeLaunch(`opened memory source ${memoryTitle(hit)}`, result),
      };
    }
  }

  private searchMemory(): MemorySearchHit[] {
    const query = this.state.query.trim();
    if (!query) return [];
    return this.manager.searchMemory(query, { limit: 12 });
  }

  private search(query: string, status: TuiStatus, immediate: boolean): void {
    this.state = {
      ...clampStateSelection({ ...this.state, status }, filterVisibleData(this.data, this.state.query)),
    };
    this.clearMemorySearchTimer();
    if (!query.trim()) {
      this.setData({ ...this.data, memoryHits: [] });
      this.state = clampStateSelection(this.state, filterVisibleData(this.data, this.state.query));
      return;
    }
    if (immediate) {
      this.refreshMemorySearch(query, false);
      return;
    }
    this.memorySearchTimer = setTimeout(() => {
      this.memorySearchTimer = undefined;
      this.refreshMemorySearch(query);
    }, MEMORY_SEARCH_DEBOUNCE_MS);
  }

  private refreshMemorySearch(query: string, render = true): void {
    if (this.stopped || query !== this.state.query.trim()) return;
    try {
      this.setData({
        ...this.data,
        memoryHits: this.manager.searchMemory(query, { limit: 12 }),
      });
      this.state = clampStateSelection(this.state, filterVisibleData(this.data, this.state.query));
      if (render) this.render();
    } catch (error) {
      this.state = { ...this.state, status: errorStatus(error) };
      if (render) this.render();
    }
  }

  private clearMemorySearchTimer(): void {
    if (!this.memorySearchTimer) return;
    clearTimeout(this.memorySearchTimer);
    this.memorySearchTimer = undefined;
  }

  private setData(data: TuiData): void {
    this.data = data;
    primeVisibleDataCache(this.data);
  }

  private loadSessions(force: boolean): ReturnType<TuiManager["listSessionsResult"]> {
    const now = Date.now();
    const cached = this.sessionCache.get(this.state.filter);
    if (!force && cached && now - cached.at < DISCOVERY_CACHE_TTL_MS) {
      return cached.result;
    }
    const result = this.manager.listSessionsResult(this.state.filter);
    this.sessionCache.set(this.state.filter, { at: now, result });
    return result;
  }

  private loadLayouts(force: boolean): Workspace[] {
    const now = Date.now();
    if (!force && this.layoutCache && now - this.layoutCache.at < DISCOVERY_CACHE_TTL_MS) {
      return this.layoutCache.workspaces;
    }
    const workspaces = sortWorkspaces([...this.manager.listWorkspaces(), ...this.manager.listSnapshots()]);
    this.layoutCache = { at: now, workspaces };
    return workspaces;
  }

  private scheduleRender(): void {
    if (this.renderTimer || this.stopped) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, RESIZE_RENDER_DEBOUNCE_MS);
  }

  private clearRenderTimer(): void {
    if (!this.renderTimer) return;
    clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
  }

  private scheduleMemoryPrewarm(): void {
    this.clearMemoryPrewarmTimer();
    this.memoryPrewarmTimer = setTimeout(() => {
      this.memoryPrewarmTimer = undefined;
      if (this.stopped || this.state.query.trim()) return;
      try {
        this.manager.searchMemory("", { limit: 1 });
      } catch {
        // Memory is opportunistic in the TUI; an index failure should not make navigation sluggish or fatal.
      }
    }, MEMORY_PREWARM_DELAY_MS);
  }

  private clearMemoryPrewarmTimer(): void {
    if (!this.memoryPrewarmTimer) return;
    clearTimeout(this.memoryPrewarmTimer);
    this.memoryPrewarmTimer = undefined;
  }

  private writeFrame(frame: string, rows: number): void {
    const lines = padFrameLines(frame, rows);
    if (!this.lastFrameLines) {
      this.stdout.write(`\x1b[H${lines.join("\n")}\x1b[0J`);
      this.lastFrameLines = lines;
      return;
    }

    const writes: string[] = [];
    const maxRows = Math.max(lines.length, this.lastFrameLines.length);
    for (let index = 0; index < maxRows; index += 1) {
      const line = lines[index] ?? "";
      if (line !== (this.lastFrameLines[index] ?? "")) {
        writes.push(`\x1b[${index + 1};1H${line}\x1b[K`);
      }
    }
    if (writes.length > 0) {
      this.stdout.write(writes.join(""));
    }
    this.lastFrameLines = lines;
  }

  private saveWorkspace(name: string): void {
    if (!name) {
      this.state = {
        ...this.state,
        mode: "save-workspace",
        status: { kind: "error", message: "workspace name is required" },
      };
      return;
    }

    const workspace = this.manager.createWorkspace({
      name,
      fromLive: true,
      filter: "open",
    });
    this.layoutCache = undefined;
    this.refresh({ kind: "success", message: `workspace saved from open live layout: ${workspace.name}` }, "layouts", true);
  }
}

function memoryTitle(hit: MemorySearchHit): string {
  return hit.memory.title ?? hit.memory.sessionId.slice(0, 8);
}

function padFrameLines(frame: string, rows: number): string[] {
  const lines = frame.split("\n").slice(0, Math.max(0, rows));
  while (lines.length < rows) {
    lines.push("");
  }
  return lines;
}
