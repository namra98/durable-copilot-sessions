import process from "node:process";
import { SessionManager } from "../core/manager.js";
import type { LaunchResult, Workspace } from "../core/types.js";
import {
  clampIndex,
  clampStateSelection,
  filterVisibleData,
  nextSessionFilter,
  renderTui,
  sessionTitle,
  type TuiData,
  type TuiState,
  type TuiStatus,
} from "./tuiModel.js";

interface TuiIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

const ENTER_KEYS = new Set(["\r", "\n"]);
const BACKSPACE_KEYS = new Set(["\u007f", "\b"]);

export async function runTui(manager = new SessionManager(), io: TuiIo = process): Promise<void> {
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
  private readonly manager: SessionManager;
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private state: TuiState;
  private data: TuiData;
  private stopped: boolean;
  private originalRawMode: boolean;
  private resolveStop?: () => void;
  private readonly onData: (chunk: Buffer | string) => void;
  private readonly onResize: () => void;
  private readonly onSigint: () => void;

  constructor(manager: SessionManager, io: TuiIo) {
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
    if (input.includes("\u0003")) {
      this.stop();
      return;
    }

    if (this.state.mode !== "normal") {
      await this.handleTextInput(input);
      this.render();
      return;
    }

    if (input === "\u001b[A" || input === "k") {
      this.moveSelection(-1);
    } else if (input === "\u001b[B" || input === "j") {
      this.moveSelection(1);
    } else if (input === "\t") {
      this.state = {
        ...this.state,
        pane: this.state.pane === "sessions" ? "workspaces" : "sessions",
      };
    } else if (input === "f") {
      const filter = nextSessionFilter(this.state.filter);
      this.state = { ...this.state, filter, sessionIndex: 0 };
      this.refresh({ kind: "info", message: `filter set to ${filter}` });
    } else if (input === "/") {
      this.state = { ...this.state, mode: "search", input: this.state.query };
    } else if (input === "r") {
      this.refresh({ kind: "success", message: "refreshed" });
    } else if (input === "w") {
      this.state = { ...this.state, mode: "save-workspace", input: defaultWorkspaceName() };
    } else if (input === "n") {
      const snapshot = this.manager.snapshot();
      this.refresh({ kind: "success", message: `snapshot saved: ${snapshot.name}` });
    } else if (ENTER_KEYS.has(input)) {
      this.activateSelection();
    } else if (input === "q" || input === "\u001b") {
      if (input === "\u001b" && this.state.query) {
        this.state = { ...this.state, query: "", sessionIndex: 0, workspaceIndex: 0 };
        this.refresh({ kind: "info", message: "search cleared" });
      } else {
        this.stop();
        return;
      }
    }

    this.render();
  }

  private async handleTextInput(input: string): Promise<void> {
    if (input === "\u001b") {
      this.state = { ...this.state, mode: "normal", input: "" };
      return;
    }

    if (ENTER_KEYS.has(input)) {
      if (this.state.mode === "search") {
        this.state = {
          ...this.state,
          mode: "normal",
          query: this.state.input.trim(),
          input: "",
          sessionIndex: 0,
          workspaceIndex: 0,
        };
        this.refresh({ kind: "info", message: "search applied" });
      } else {
        this.saveWorkspace(this.state.input.trim());
      }
      return;
    }

    if (BACKSPACE_KEYS.has(input)) {
      this.state = { ...this.state, input: this.state.input.slice(0, -1) };
      return;
    }

    let nextInput = this.state.input;
    for (const char of input) {
      if (char >= " " && char !== "\u007f") {
        nextInput += char;
      }
    }
    this.state = { ...this.state, input: nextInput };
  }

  private moveSelection(delta: number): void {
    const visible = filterVisibleData(this.data, this.state.query);
    if (this.state.pane === "sessions") {
      this.state = {
        ...this.state,
        sessionIndex: clampIndex(this.state.sessionIndex + delta, visible.sessions.length),
      };
    } else {
      this.state = {
        ...this.state,
        workspaceIndex: clampIndex(this.state.workspaceIndex + delta, visible.workspaces.length),
      };
    }
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
      filter: this.state.filter,
    });
    this.state = {
      ...this.state,
      mode: "normal",
      input: "",
      pane: "workspaces",
      workspaceIndex: 0,
    };
    this.refresh({ kind: "success", message: `workspace saved: ${workspace.name}` });
  }
}
