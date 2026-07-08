import type { SessionFilter, SessionListResult, SessionView } from "../core/manager.js";
import type { Workspace } from "../core/types.js";

export type TuiPane = "sessions" | "workspaces";
export type TuiMode = "normal" | "search" | "save-workspace" | "help";
export type TuiStatusKind = "info" | "success" | "error";
export type TuiThemeName = "midnight" | "aurora" | "mono";

export interface TuiStatus {
  kind: TuiStatusKind;
  message: string;
}

export interface TuiState {
  pane: TuiPane;
  filter: SessionFilter;
  theme: TuiThemeName;
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
  color?: boolean;
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
const THEME_ORDER: TuiThemeName[] = ["midnight", "aurora", "mono"];
const ENTER_KEYS = new Set(["\r", "\n"]);
const BACKSPACE_KEYS = new Set(["\u007f", "\b"]);

interface TuiTheme {
  label: string;
  accent: string;
  dim: string;
  border: string;
  title: string;
  selected: string;
  success: string;
  warning: string;
  error: string;
}

const THEMES: Record<TuiThemeName, TuiTheme> = {
  midnight: {
    label: "Midnight",
    accent: "38;2;125;211;252",
    dim: "38;2;148;163;184",
    border: "38;2;51;65;85",
    title: "1;38;2;226;232;240",
    selected: "1;38;2;15;23;42;48;2;125;211;252",
    success: "38;2;74;222;128",
    warning: "38;2;250;204;21",
    error: "38;2;248;113;113",
  },
  aurora: {
    label: "Aurora",
    accent: "38;2;167;139;250",
    dim: "38;2;156;163;175",
    border: "38;2;76;29;149",
    title: "1;38;2;245;243;255",
    selected: "1;38;2;250;245;255;48;2;126;34;206",
    success: "38;2;52;211;153",
    warning: "38;2;251;191;36",
    error: "38;2;251;113;133",
  },
  mono: {
    label: "Mono",
    accent: "1",
    dim: "2",
    border: "2",
    title: "1",
    selected: "7",
    success: "1",
    warning: "1",
    error: "1",
  },
};

const ICONS = {
  app: "◆",
  session: "◉",
  workspace: "▣",
  live: "●",
  stale: "◌",
  inactive: "○",
  selected: "▶",
  search: "⌕",
  save: "✦",
  snapshot: "◇",
  theme: "◈",
  help: "?",
};

export function nextSessionFilter(filter: SessionFilter): SessionFilter {
  const index = FILTER_ORDER.indexOf(filter);
  return FILTER_ORDER[(index + 1) % FILTER_ORDER.length];
}

export function nextTheme(theme: TuiThemeName): TuiThemeName {
  const index = THEME_ORDER.indexOf(theme);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length];
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

  if (state.mode === "help") {
    if (input === "?" || input === "q" || input === "\u001b") {
      return { state: { ...state, mode: "normal" } };
    }
    return { state };
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
  if (input === "\u001b[5~") {
    return { state: moveSelection(state, data, -8) };
  }
  if (input === "\u001b[6~") {
    return { state: moveSelection(state, data, 8) };
  }
  if (input === "g" || input === "\u001b[H" || input === "\u001b[1~") {
    return { state: moveSelectionTo(state, data, "start") };
  }
  if (input === "G" || input === "\u001b[F" || input === "\u001b[4~") {
    return { state: moveSelectionTo(state, data, "end") };
  }
  if (input === "\t" || input === "h" || input === "l" || input === "\u001b[D" || input === "\u001b[C") {
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
  if (input === "?") {
    return { state: { ...state, mode: "help" } };
  }
  if (input === "t") {
    const theme = nextTheme(state.theme);
    return {
      state: {
        ...state,
        theme,
        status: { kind: "info", message: `theme set to ${THEMES[theme].label}` },
      },
    };
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

function moveSelectionTo(state: TuiState, data: TuiData, target: "start" | "end"): TuiState {
  const visible = filterVisibleData(data, state.query);
  if (state.pane === "sessions") {
    return {
      ...state,
      sessionIndex: target === "start" ? 0 : Math.max(visible.sessions.length - 1, 0),
    };
  }
  return {
    ...state,
    workspaceIndex: target === "start" ? 0 : Math.max(visible.workspaces.length - 1, 0),
  };
}

export function formatSessionRow(session: SessionView, selected: boolean, width: number): string {
  const marker = selected ? ICONS.selected : " ";
  const liveIcon = session.liveness === "live" ? ICONS.live : session.liveness === "stale" ? ICONS.stale : ICONS.inactive;
  const child = session.childCount && session.childCount > 0 ? ` +${session.childCount}` : "";
  const repo = session.repository ? ` ${session.repository}${session.branch ? `@${session.branch}` : ""}` : "";
  const title = sessionTitle(session);
  const line = `${marker} ${liveIcon} ${statusLabel(session).padEnd(5)} ${session.id.slice(0, 8)}  ${title}${child}${repo}`;
  return truncateText(line, width);
}

export function formatWorkspaceRow(workspace: Workspace, selected: boolean, width: number): string {
  const marker = selected ? ICONS.selected : " ";
  const tabs = workspaceTabCount(workspace);
  const windows = workspace.windows.length;
  const updated = workspace.updatedAt.slice(0, 19).replace("T", " ");
  const sourceIcon = workspace.source === "auto-snapshot" ? ICONS.snapshot : ICONS.workspace;
  const line = `${marker} ${sourceIcon} ${workspace.source}  ${workspace.name}  ${tabs} tab(s) / ${windows} window(s)  ${updated}`;
  return truncateText(line, width);
}

function paint(text: string, code: string, color: boolean): string {
  if (!color || !code) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

function fitText(text: string, width: number): string {
  return truncateText(text, width).padEnd(Math.max(0, width));
}

function styledLine(text: string, width: number, code: string, color: boolean): string {
  return paint(fitText(text, width), code, color);
}

function boxBorder(title: string, width: number, side: "top" | "bottom"): string {
  if (width <= 1) return side === "top" ? "╭" : "╰";
  if (width === 2) return side === "top" ? "╭╮" : "╰╯";
  const left = side === "top" ? "╭" : "╰";
  const right = side === "top" ? "╮" : "╯";
  if (side === "bottom") return `${left}${"─".repeat(width - 2)}${right}`;
  const label = truncateText(` ${title} `, width - 2);
  return `${left}${label}${"─".repeat(Math.max(0, width - 2 - label.length))}${right}`;
}

function box(title: string, body: string[], width: number, height: number, theme: TuiTheme, color: boolean, active = false): string[] {
  if (height <= 0) return [];
  if (height === 1) return [styledLine(boxBorder(title, width, "top"), width, theme.border, color)];
  const innerWidth = Math.max(0, width - 2);
  const borderStyle = active ? theme.accent : theme.border;
  const lines = [styledLine(boxBorder(title, width, "top"), width, borderStyle, color)];
  const innerHeight = Math.max(0, height - 2);
  for (let i = 0; i < innerHeight; i += 1) {
    const content = fitText(body[i] ?? "", innerWidth);
    lines.push(paint("│", borderStyle, color) + content + paint("│", borderStyle, color));
  }
  lines.push(styledLine(boxBorder(title, width, "bottom"), width, borderStyle, color));
  return lines.slice(0, height);
}

function combineColumns(left: string[], right: string[], gap: string): string[] {
  const height = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let i = 0; i < height; i += 1) {
    lines.push(`${left[i] ?? ""}${gap}${right[i] ?? ""}`);
  }
  return lines;
}

function helpLine(mode: TuiMode): string {
  if (mode === "search") return "Search: type text, Enter apply, Esc cancel";
  if (mode === "save-workspace") return "Save workspace: type name, Enter save, Esc cancel";
  if (mode === "help") return "Help: press Esc, ?, or q to return";
  return "↑/↓ j/k move | ←/→ h/l pane | PgUp/PgDn jump | t theme | ? help | Enter open | w save open layout | q quit";
}

function renderStatus(status: TuiStatus | undefined, width: number, theme: TuiTheme, color: boolean): string {
  if (!status) return styledLine("Status: ready", width, theme.dim, color);
  const style = status.kind === "success" ? theme.success : status.kind === "error" ? theme.error : theme.accent;
  return styledLine(`Status (${status.kind}): ${status.message}`, width, style, color);
}

function formatActiveRow(
  pane: TuiPane,
  row: SessionView | Workspace,
  selected: boolean,
  width: number,
  theme: TuiTheme,
  color: boolean,
): string {
  const line = pane === "sessions"
    ? formatSessionRow(row as SessionView, selected, width)
    : formatWorkspaceRow(row as Workspace, selected, width);
  return selected ? paint(fitText(line, width), theme.selected, color) : fitText(line, width);
}

function metric(label: string, value: number, icon: string): string {
  return `${icon} ${value} ${label}`;
}

function repoLine(session: SessionView): string {
  if (!session.repository) return "Repo: (none)";
  return `Repo: ${session.repository}${session.branch ? ` @ ${session.branch}` : ""}`;
}

function sessionDetails(session: SessionView | undefined): string[] {
  if (!session) return ["No session selected.", "Use f or / to discover matching sessions."];
  return [
    `${ICONS.session} ${sessionTitle(session)}`,
    `Status: ${statusLabel(session)}${session.topLevel ? " top-level" : " child"}`,
    repoLine(session),
    `CWD: ${session.cwd}${session.cwdExists ? "" : " (missing)"}`,
    `Updated: ${session.updatedAt?.slice(0, 19).replace("T", " ") ?? "(unknown)"}`,
    `Live PIDs: ${session.livePids.length > 0 ? session.livePids.join(", ") : "(none)"}`,
    session.summary ? `Summary: ${session.summary}` : "Summary: (none)",
    session.childCount ? `Children: ${session.childCount}` : "Children: 0",
  ];
}

function workspaceDetails(workspace: Workspace | undefined): string[] {
  if (!workspace) return ["No workspace selected.", "Press w to save the current open live layout."];
  return [
    `${ICONS.workspace} ${workspace.name}`,
    `Source: ${workspace.source}`,
    `Windows: ${workspace.windows.length}`,
    `Tabs: ${workspaceTabCount(workspace)}`,
    `Updated: ${workspace.updatedAt.slice(0, 19).replace("T", " ")}`,
    workspace.description ? `Description: ${workspace.description}` : "Description: (none)",
    `ID: ${workspace.id}`,
  ];
}

function selectedDetails(state: TuiState, visible: VisibleTuiData): string[] {
  if (state.pane === "sessions") {
    return sessionDetails(visible.sessions[state.sessionIndex]);
  }
  return workspaceDetails(visible.workspaces[state.workspaceIndex]);
}

function renderHeader(
  state: TuiState,
  data: TuiData,
  visible: VisibleTuiData,
  width: number,
  theme: TuiTheme,
  color: boolean,
): string[] {
  const liveCount = data.sessions.sessions.filter((session) => session.liveness === "live").length;
  const staleCount = data.sessions.sessions.filter((session) => session.liveness === "stale").length;
  return [
    styledLine(`${ICONS.app} Durable Copilot Sessions TUI`, width, theme.title, color),
    styledLine(
      [
        metric("open terminals", data.sessions.openCount, ICONS.live),
        metric("live", liveCount, ICONS.session),
        metric("stale", staleCount, ICONS.stale),
        metric("layouts", data.workspaces.length, ICONS.workspace),
        `${ICONS.theme} ${THEMES[state.theme].label}`,
      ].join("  "),
      width,
      theme.accent,
      color,
    ),
    styledLine(
      `Pane: ${state.pane} | Filter: ${state.filter} | Search: ${state.query || "(none)"} | Showing ${visible.sessions.length} session(s), ${visible.workspaces.length} layout(s)`,
      width,
      theme.dim,
      color,
    ),
  ];
}

function renderHelpBody(theme: TuiTheme, color: boolean): string[] {
  return [
    paint("Navigation", theme.accent, color),
    "  ↑/↓ or j/k       Move selection",
    "  PgUp/PgDn         Jump through the list",
    "  g / G             First / last item",
    "  ←/→ or h/l or Tab Switch sessions/workspaces",
    paint("Actions", theme.accent, color),
    "  Enter             Resume selected session or restore selected layout",
    "  w                 Save current open live layout",
    "  n                 Take an auto-snapshot",
    "  r                 Refresh",
    "  /                 Search",
    "  f                 Cycle open/live/all filters",
    "  t                 Cycle theme",
    "  ?                 Toggle help",
  ];
}

function renderRows(
  state: TuiState,
  visible: VisibleTuiData,
  rowWidth: number,
  rowCount: number,
  theme: TuiTheme,
  color: boolean,
): string[] {
  const activeRows = state.pane === "sessions" ? visible.sessions : visible.workspaces;
  const selectedIndex = state.pane === "sessions" ? state.sessionIndex : state.workspaceIndex;
  const first = Math.max(0, selectedIndex - rowCount + 1);
  const rows = activeRows.slice(first, first + rowCount);
  if (rows.length === 0) {
    return [
      state.pane === "sessions" ? "No sessions match the current view." : "No layouts match the current view.",
      state.pane === "sessions" ? "Try f for live/all or / to clear search." : "Press w to save the current layout.",
    ];
  }
  return rows.map((row, index) =>
    formatActiveRow(state.pane, row, first + index === selectedIndex, rowWidth, theme, color),
  );
}

function renderFooter(state: TuiState, width: number, theme: TuiTheme, color: boolean): string[] {
  const lines = [
    renderStatus(state.status, width, theme, color),
    styledLine(helpLine(state.mode), width, theme.dim, color),
  ];
  if (state.mode === "search" || state.mode === "save-workspace") {
    const icon = state.mode === "search" ? ICONS.search : ICONS.save;
    lines.push(styledLine(`${icon} ${state.input}_`, width, theme.accent, color));
  }
  return lines;
}

function renderWideDashboard(
  state: TuiState,
  data: TuiData,
  visible: VisibleTuiData,
  width: number,
  height: number,
  theme: TuiTheme,
  color: boolean,
): string[] {
  const header = renderHeader(state, data, visible, width, theme, color);
  const footer = renderFooter(state, width, theme, color);
  const bodyHeight = Math.max(3, height - header.length - footer.length);
  const gap = " ";
  const detailWidth = Math.max(32, Math.floor(width * 0.38));
  const listWidth = Math.max(40, width - detailWidth - gap.length);
  const rowCount = Math.max(1, bodyHeight - 2);
  const body =
    state.mode === "help"
      ? box("Shortcuts", renderHelpBody(theme, color), width, bodyHeight, theme, color, true)
      : combineColumns(
          box(
            `${state.pane === "sessions" ? ICONS.session : ICONS.workspace} ${state.pane === "sessions" ? "Sessions" : "Workspaces"}`,
            renderRows(state, visible, listWidth - 2, rowCount, theme, color),
            listWidth,
            bodyHeight,
            theme,
            color,
            true,
          ),
          box("Details", selectedDetails(state, visible), detailWidth, bodyHeight, theme, color),
          gap,
        );
  return [...header, ...body, ...footer].slice(0, height);
}

function renderCompactDashboard(
  state: TuiState,
  data: TuiData,
  visible: VisibleTuiData,
  width: number,
  height: number,
  theme: TuiTheme,
  color: boolean,
): string[] {
  const header = renderHeader(state, data, visible, width, theme, color).slice(0, 2);
  const footer = renderFooter(state, width, theme, color);
  const bodyHeight = Math.max(3, height - header.length - footer.length);
  const rowCount = Math.max(1, bodyHeight - 2);
  const body =
    state.mode === "help"
      ? box("Shortcuts", renderHelpBody(theme, color), width, bodyHeight, theme, color, true)
      : box(
          `${state.pane === "sessions" ? ICONS.session : ICONS.workspace} ${state.pane === "sessions" ? "Sessions" : "Workspaces"}`,
          renderRows(state, visible, width - 2, rowCount, theme, color),
          width,
          bodyHeight,
          theme,
          color,
          true,
        );
  return [...header, ...body, ...footer].slice(0, height);
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
  const theme = THEMES[safeState.theme];
  const color = options.color ?? false;
  const lines =
    width >= 96 && height >= 16
      ? renderWideDashboard(safeState, data, visible, width, height, theme, color)
      : renderCompactDashboard(safeState, data, visible, width, height, theme, color);
  return lines.slice(0, height).join("\n");
}
