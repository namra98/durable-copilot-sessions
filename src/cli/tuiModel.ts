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

const FILTER_ORDER: SessionFilter[] = ["open", "live", "all"];

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
  return "Keys: up/down or j/k move | Tab pane | f filter | / search | Enter resume/restore | w save | n snapshot | r refresh | q quit";
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
  const width = Math.max(40, options.columns);
  const height = Math.max(10, options.rows);
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
