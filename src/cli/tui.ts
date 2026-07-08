import process from "node:process";
import { SessionManager } from "../core/manager.js";
import type { LaunchResult, Workspace } from "../core/types.js";
import {
  clampStateSelection,
  filterVisibleData,
  handleTuiInput,
  renderTui,
  sessionTitle,
  type TuiData,
  type TuiCommand,
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
    query: "",
    mode: "normal",
    input: "",
    sessionIndex: 0,
    workspaceIndex: 0,
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

class TuiApp {
  private readonly manager: TuiManager;
  private readonly stdin: TuiInput;
  private readonly stdout: TuiOutput;
  private state: TuiState;
  private data: TuiData;
  private stopped: boolean;
  private originalRawMode: boolean;
  private resolveStop?: () => void;
  private readonly onData: (chunk: Buffer | string) => void;
  private readonly onResize: () => void;
  private readonly onSigint: () => void;

  constructor(manager: TuiManager, io: TuiIo) {
    this.manager = manager;
    this.stdin = io.stdin;
    this.stdout = io.stdout;
    this.state = defaultState();
    this.data = { sessions: { sessions: [], openCount: 0 }, workspaces: [] };
    this.stopped = false;
    this.originalRawMode = this.stdin.isRaw;
    this.onData = (chunk) => {
      void this.handleInput(chunk.toString()).catch((error: unknown) => {
        this.state = { ...this.state, status: errorStatus(error) };
        this.render();
      });
    };
    this.onResize = () => this.render();
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
      this.refresh({ kind: "info", message: "loaded sessions and workspaces" });
      this.render();

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
    this.stdin.setRawMode(this.originalRawMode);
    this.stdout.write("\x1b[?25h\x1b[?1049l");
    this.resolveStop?.();
  }

  private refresh(status?: TuiStatus): void {
    this.data = {
      sessions: this.manager.listSessionsResult(this.state.filter),
      workspaces: sortWorkspaces([...this.manager.listWorkspaces(), ...this.manager.listSnapshots()]),
    };
    this.state = clampStateSelection(
      {
        ...this.state,
        status: status ?? this.state.status,
      },
      filterVisibleData(this.data, this.state.query),
    );
  }

  private render(): void {
    const columns = this.stdout.columns ?? 100;
    const rows = this.stdout.rows ?? 30;
    this.stdout.write("\x1b[2J\x1b[H");
    this.stdout.write(renderTui(this.state, this.data, { columns, rows }));
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
      this.refresh(command.status);
    } else if (command.kind === "snapshot") {
      const snapshot = this.manager.snapshot();
      this.refresh({ kind: "success", message: `snapshot saved: ${snapshot.name}` });
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
    } else {
      const workspace = visible.workspaces[this.state.workspaceIndex];
      if (!workspace) {
        this.state = { ...this.state, status: { kind: "error", message: "no workspace selected" } };
        return;
      }
      const result = this.manager.restoreWorkspace(workspace.id, { window: "new" });
      this.state = { ...this.state, status: summarizeLaunch(`restored ${workspace.name}`, result) };
    }
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
    this.refresh({ kind: "success", message: `workspace saved from open live layout: ${workspace.name}` });
  }
}
