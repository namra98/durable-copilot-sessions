import type { SessionFilter, SessionListResult, SessionView } from "../core/manager.js";
import type { Workspace } from "../core/types.js";

export type TuiPane = "sessions" | "workspaces";
export type TuiMode = "normal" | "search" | "save-workspace";
export type TuiStatusKind = "info" | "success" | "error";

export interface TuiStatus {
  kind: TuiStatusKind;
  message: string;
}

export interface TuiState {
  pane: TuiPane;
  filter: SessionFilter;
  query: string;
  mode: TuiMode;
  input: string;
  sessionIndex: number;
  workspaceIndex: number;
  status?: TuiStatus;
}

export interface TuiData {
  sessions: SessionListResult;
  workspaces: Workspace[];
}

export interface TuiRenderOptions {
  columns: number;
  rows: number;
}

export interface VisibleTuiData {
  sessions: SessionView[];
  workspaces: Workspace[];
}

export type TuiCommand =
  | { kind: "activate" }
  | { kind: "refresh"; status: TuiStatus }
  | { kind: "snapshot" }
  | { kind: "save-workspace"; name: string }
  | { kind: "quit" };

export interface TuiInputResult {
  state: TuiState;
  command?: TuiCommand;
}

export interface TuiInputOptions {
  defaultWorkspaceName: string;
}

const FILTER_ORDER: SessionFilter[] = ["open", "live", "all"];
const ENTER_KEYS = new Set(["\r", "\n"]);
const BACKSPACE_KEYS = new Set(["\u007f", "\b"]);

export function nextSessionFilter(filter: SessionFilter): SessionFilter {
  const index = FILTER_ORDER.indexOf(filter);
  return FILTER_ORDER[(index + 1) % FILTER_ORDER.length];
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return length - 1;
  if (index >= length) return 0;
  return index;
}

export function sessionTitle(session: SessionView): string {
  return session.title ?? session.name ?? session.id.slice(0, 8);
}

export function workspaceTabCount(workspace: Workspace): number {
  return workspace.windows.reduce((count, window) => count + window.tabs.length, 0);
}

export function statusLabel(session: SessionView): string {
  if (session.liveness === "live") return "live";
  if (session.liveness === "stale") return "stale";
  return "idle";
}

export function truncateText(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 3) return ".".repeat(width);
  return `${text.slice(0, width - 3)}...`;
}

function normalize(value: string | undefined): string {
  return value?.toLowerCase() ?? "";
}

function matchesQuery(values: Array<string | undefined>, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return values.some((value) => normalize(value).includes(needle));
}

export function filterVisibleData(data: TuiData, query: string): VisibleTuiData {
  return {
    sessions: data.sessions.sessions.filter((session) =>
      matchesQuery(
        [
          session.id,
          sessionTitle(session),
          session.summary,
          session.repository,
          session.branch,
          session.cwd,
        ],
        query,
      ),
    ),
    workspaces: data.workspaces.filter((workspace) =>
      matchesQuery([workspace.id, workspace.name, workspace.description, workspace.source], query),
    ),
  };
}

export function clampStateSelection(state: TuiState, visible: VisibleTuiData): TuiState {
  return {
    ...state,
    sessionIndex: Math.min(state.sessionIndex, Math.max(visible.sessions.length - 1, 0)),
    workspaceIndex: Math.min(state.workspaceIndex, Math.max(visible.workspaces.length - 1, 0)),
  };
}

export function handleTuiInput(
  state: TuiState,
  data: TuiData,
  input: string,
  options: TuiInputOptions,
): TuiInputResult {
  if (input.includes("\u0003")) {
    return { state, command: { kind: "quit" } };
  }

  if (state.mode !== "normal") {
    return handleTextInput(state, input);
  }

  if (input === "\u001b[A" || input === "k") {
    return { state: moveSelection(state, data, -1) };
  }
  if (input === "\u001b[B" || input === "j") {
    return { state: moveSelection(state, data, 1) };
  }
  if (input === "\t") {
    return {
      state: {
        ...state,
        pane: state.pane === "sessions" ? "workspaces" : "sessions",
      },
    };
  }
  if (input === "f") {
    const filter = nextSessionFilter(state.filter);
    return {
      state: { ...state, filter, sessionIndex: 0 },
      command: { kind: "refresh", status: { kind: "info", message: `filter set to ${filter}` } },
    };
  }
  if (input === "/") {
    return { state: { ...state, mode: "search", input: state.query } };
  }
  if (input === "r") {
    return { state, command: { kind: "refresh", status: { kind: "success", message: "refreshed" } } };
  }
  if (input === "w") {
    return { state: { ...state, mode: "save-workspace", input: options.defaultWorkspaceName } };
  }
  if (input === "n") {
    return { state, command: { kind: "snapshot" } };
  }
  if (ENTER_KEYS.has(input)) {
    return { state, command: { kind: "activate" } };
  }
  if (input === "q" || input === "\u001b") {
    if (input === "\u001b" && state.query) {
      return {
        state: { ...state, query: "", sessionIndex: 0, workspaceIndex: 0 },
        command: { kind: "refresh", status: { kind: "info", message: "search cleared" } },
      };
    }
    return { state, command: { kind: "quit" } };
  }

  return { state };
}

function handleTextInput(state: TuiState, input: string): TuiInputResult {
  if (input === "\u001b") {
    return { state: { ...state, mode: "normal", input: "" } };
  }

  if (input.includes("\u001b")) {
    return { state };
  }

  if (ENTER_KEYS.has(input)) {
    if (state.mode === "search") {
      return {
        state: {
          ...state,
          mode: "normal",
          query: state.input.trim(),
          input: "",
          sessionIndex: 0,
          workspaceIndex: 0,
        },
        command: { kind: "refresh", status: { kind: "info", message: "search applied" } },
      };
    }

    const name = state.input.trim();
    if (!name) {
      return {
        state: {
          ...state,
          status: { kind: "error", message: "workspace name is required" },
        },
      };
    }

    return {
      state: {
        ...state,
        mode: "normal",
        input: "",
        pane: "workspaces",
        workspaceIndex: 0,
      },
      command: { kind: "save-workspace", name },
    };
  }

  if (BACKSPACE_KEYS.has(input)) {
    return { state: { ...state, input: state.input.slice(0, -1) } };
  }

  let nextInput = state.input;
  for (const char of input) {
    if (char >= " " && char !== "\u007f") {
      nextInput += char;
    }
  }
  return { state: { ...state, input: nextInput } };
}

function moveSelection(state: TuiState, data: TuiData, delta: number): TuiState {
  const visible = filterVisibleData(data, state.query);
  if (state.pane === "sessions") {
    return {
      ...state,
      sessionIndex: clampIndex(state.sessionIndex + delta, visible.sessions.length),
    };
  }
  return {
    ...state,
    workspaceIndex: clampIndex(state.workspaceIndex + delta, visible.workspaces.length),
  };
}

export function formatSessionRow(session: SessionView, selected: boolean, width: number): string {
  const marker = selected ? ">" : " ";
  const child = session.childCount && session.childCount > 0 ? ` +${session.childCount}` : "";
  const repo = session.repository ? ` ${session.repository}${session.branch ? `@${session.branch}` : ""}` : "";
  const title = sessionTitle(session);
  const line = `${marker} [${statusLabel(session).padEnd(5)}] ${session.id.slice(0, 8)} ${title}${child}${repo}`;
  return truncateText(line, width);
}

export function formatWorkspaceRow(workspace: Workspace, selected: boolean, width: number): string {
  const marker = selected ? ">" : " ";
  const tabs = workspaceTabCount(workspace);
  const windows = workspace.windows.length;
  const updated = workspace.updatedAt.slice(0, 19).replace("T", " ");
  const line = `${marker} [${workspace.source}] ${workspace.name}  ${tabs} tab(s) / ${windows} window(s)  ${updated}`;
  return truncateText(line, width);
}

function helpLine(mode: TuiMode): string {
  if (mode === "search") return "Search: type text, Enter apply, Esc cancel";
  if (mode === "save-workspace") return "Save workspace: type name, Enter save, Esc cancel";
  return "Keys: up/down or j/k move | Tab pane | f filter | / search | Enter resume/restore | w save open layout | n snapshot | r refresh | q quit";
}

function renderStatus(status: TuiStatus | undefined, width: number): string {
  if (!status) return truncateText("Status: ready", width);
  return truncateText(`Status (${status.kind}): ${status.message}`, width);
}

function formatActiveRow(
  pane: TuiPane,
  row: SessionView | Workspace,
  selected: boolean,
  width: number,
): string {
  return pane === "sessions"
    ? formatSessionRow(row as SessionView, selected, width)
    : formatWorkspaceRow(row as Workspace, selected, width);
}

export function renderTui(state: TuiState, data: TuiData, options: TuiRenderOptions): string {
  const width = Math.max(1, options.columns);
  const height = Math.max(0, options.rows);
  if (height === 0) return "";
  if (options.columns < 40 || options.rows < 10) {
    return [
      "Durable Copilot Sessions TUI",
      "Terminal too small",
      "Minimum size: 40x10",
    ]
      .map((line) => truncateText(line, width))
      .slice(0, height)
      .join("\n");
  }
  const visible = filterVisibleData(data, state.query);
  const safeState = clampStateSelection(state, visible);
  const activeRows = safeState.pane === "sessions" ? visible.sessions : visible.workspaces;
  const promptRows = safeState.mode === "normal" ? 0 : 2;
  const maxListRows = Math.max(1, height - 6 - promptRows);
  const selectedIndex = safeState.pane === "sessions" ? safeState.sessionIndex : safeState.workspaceIndex;
  const first = Math.max(0, selectedIndex - maxListRows + 1);
  const rows = activeRows.slice(first, first + maxListRows);
  const lines: string[] = [
    truncateText("Durable Copilot Sessions TUI", width),
    truncateText(
      `Pane: ${safeState.pane} | Filter: ${safeState.filter} | Search: ${safeState.query || "(none)"} | Open terminals: ${data.sessions.openCount}`,
      width,
    ),
    truncateText(helpLine(safeState.mode), width),
    renderStatus(safeState.status, width),
    "",
  ];

  if (safeState.pane === "sessions") {
    lines.push(
      truncateText(`Sessions (${visible.sessions.length} shown / ${data.sessions.sessions.length} loaded)`, width),
    );
  } else {
    lines.push(
      truncateText(`Workspaces (${visible.workspaces.length} shown / ${data.workspaces.length} loaded)`, width),
    );
  }

  for (let i = 0; i < rows.length; i += 1) {
    lines.push(formatActiveRow(safeState.pane, rows[i], first + i === selectedIndex, width));
  }

  if (safeState.mode !== "normal") {
    lines.push("", truncateText(`> ${safeState.input}_`, width));
  }

  return lines.slice(0, height).join("\n");
}
