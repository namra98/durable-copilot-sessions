import { describe, expect, it } from "vitest";
import type { SessionView } from "../core/manager.js";
import type { MemorySearchHit, Workspace } from "../core/types.js";
import {
  clampIndex,
  filterVisibleData,
  formatSessionRow,
  formatMemoryRow,
  handleTuiInput,
  nextSessionFilter,
  nextTheme,
  renderTui,
  truncateText,
  workspaceTabCount,
  type TuiData,
  type TuiState,
} from "./tuiModel.js";

const session: SessionView = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  cwd: "C:\\repo\\durable-copilot-sessions",
  cwdExists: true,
  name: "Dashboard work",
  repository: "namra98/durable-copilot-sessions",
  branch: "main",
  liveness: "live",
  livePids: [123],
  topLevel: true,
  managed: false,
  childCount: 2,
};

const workspace: Workspace = {
  id: "workspace-1",
  name: "morning-layout",
  description: "daily sessions",
  source: "manual",
  createdAt: "2026-07-09T00:00:00.000Z",
  updatedAt: "2026-07-09T01:00:00.000Z",
  windows: [
    {
      id: "w1",
      tabs: [
        { sessionId: "a", title: "one", color: "blue", cwd: "C:\\a" },
        { sessionId: "b", title: "two", color: "green", cwd: "C:\\b" },
      ],
    },
  ],
};

const memoryHit: MemorySearchHit = {
  memory: {
    id: "memory-1",
    sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    kind: "decision",
    title: "Use terminal UI",
    content: "Decision: add memory-aware search to the TUI dashboard.",
    repository: "namra98/durable-copilot-sessions",
    branch: "main",
    sourceTable: "checkpoints",
    createdAt: Date.parse("2026-07-09T00:00:00.000Z"),
    updatedAt: Date.parse("2026-07-09T01:00:00.000Z"),
  },
  score: 1,
  snippet: "add [memory-aware] search",
};

function data(): TuiData {
  return {
    sessions: { sessions: [session], openCount: 1 },
    workspaces: [workspace],
    memoryHits: [memoryHit],
  };
}

function manySessions(count: number): SessionView[] {
  return Array.from({ length: count }, (_, index) => ({
    ...session,
    id: `session-${String(index).padStart(2, "0")}`,
    name: `Session ${index}`,
  }));
}

function state(overrides: Partial<TuiState> = {}): TuiState {
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
    ...overrides,
  };
}

describe("tuiModel", () => {
  it("cycles session filters", () => {
    expect(nextSessionFilter("open")).toBe("live");
    expect(nextSessionFilter("live")).toBe("all");
    expect(nextSessionFilter("all")).toBe("open");
  });

  it("cycles visual themes", () => {
    expect(nextTheme("midnight")).toBe("aurora");
    expect(nextTheme("aurora")).toBe("tokyo");
    expect(nextTheme("tokyo")).toBe("catppuccin");
    expect(nextTheme("catppuccin")).toBe("matrix");
    expect(nextTheme("matrix")).toBe("mono");
    expect(nextTheme("mono")).toBe("midnight");
  });

  it("wraps list indices", () => {
    expect(clampIndex(-1, 3)).toBe(2);
    expect(clampIndex(3, 3)).toBe(0);
    expect(clampIndex(0, 0)).toBe(0);
  });

  it("filters sessions and workspaces by query", () => {
    expect(filterVisibleData(data(), "durable").sessions).toHaveLength(1);
    expect(filterVisibleData(data(), "morning").workspaces).toHaveLength(1);
    expect(filterVisibleData(data(), "memory-aware").memoryHits).toHaveLength(1);
    expect(filterVisibleData(data(), "missing").sessions).toHaveLength(0);
  });

  it("formats session rows with liveness and child count", () => {
    const row = formatSessionRow(session, true, 120);
    expect(row).toContain("live ");
    expect(row).toContain("+2");
    expect(row).toContain("namra98/durable-copilot-sessions@main");
  });

  it("counts workspace tabs", () => {
    expect(workspaceTabCount(workspace)).toBe(2);
  });

  it("formats memory rows with kind, title, and snippets", () => {
    const row = formatMemoryRow(memoryHit, true, 120);
    expect(row).toContain("decision");
    expect(row).toContain("Use terminal UI");
    expect(row).toContain("memory-aware");
  });

  it("truncates text to the requested width", () => {
    expect(truncateText("abcdef", 4)).toBe("a...");
  });

  it("renders active pane, help, and status", () => {
    const screen = renderTui(state({ status: { kind: "success", message: "snapshot saved" } }), data(), {
      columns: 100,
      rows: 20,
    });
    expect(screen).toContain("Durable Copilot Sessions TUI");
    expect(screen).toContain("Filter: open");
    expect(screen).toContain("snapshot saved");
    expect(screen).toContain("Dashboard work");
    expect(screen).toContain("Details");
  });

  it("keeps input prompts visible in constrained terminals", () => {
    const screen = renderTui(
      state({ mode: "search", input: "repo", sessionIndex: 14 }),
      {
        sessions: { sessions: manySessions(15), openCount: 15 },
        workspaces: [],
        memoryHits: [],
      },
      {
        columns: 80,
        rows: 10,
      },
    );
    expect(screen).toContain("⌕ repo_");
    expect(screen.split("\n")).toHaveLength(10);
  });

  it("renders a bounded minimum-size message for tiny terminals", () => {
    const screen = renderTui(state(), data(), {
      columns: 20,
      rows: 2,
    });
    expect(screen).toContain("Terminal too small");
    expect(screen.split("\n")).toHaveLength(2);
    expect(screen.split("\n").every((line) => line.length <= 20)).toBe(true);
  });

  it("drops escape sequences while editing text input", () => {
    const result = handleTuiInput(
      state({ mode: "search", input: "repo" }),
      data(),
      "\u001b[A",
      { defaultWorkspaceName: "layout" },
    );
    expect(result.state.input).toBe("repo");
    expect(result.command).toBeUndefined();
  });

  it("emits commands for key-driven actions", () => {
    const filter = handleTuiInput(state(), data(), "f", { defaultWorkspaceName: "layout" });
    expect(filter.state.filter).toBe("live");
    expect(filter.command).toEqual({ kind: "refresh", status: { kind: "info", message: "filter set to live" } });

    const save = handleTuiInput(
      state({ mode: "save-workspace", input: "daily" }),
      data(),
      "\r",
      { defaultWorkspaceName: "layout" },
    );
    expect(save.state.pane).toBe("workspaces");
    expect(save.command).toEqual({ kind: "save-workspace", name: "daily" });
  });

  it("handles premium interaction keys", () => {
    const theme = handleTuiInput(state(), data(), "t", { defaultWorkspaceName: "layout" });
    expect(theme.state.theme).toBe("aurora");
    expect(theme.state.status?.message).toBe("theme set to Aurora");

    const help = handleTuiInput(state(), data(), "?", { defaultWorkspaceName: "layout" });
    expect(help.state.mode).toBe("help");

    const closedHelp = handleTuiInput(state({ mode: "help" }), data(), "\u001b", {
      defaultWorkspaceName: "layout",
    });
    expect(closedHelp.state.mode).toBe("normal");

    const pane = handleTuiInput(state(), data(), "\u001b[C", { defaultWorkspaceName: "layout" });
    expect(pane.state.pane).toBe("workspaces");

    const memory = handleTuiInput(state(), data(), "m", { defaultWorkspaceName: "layout" });
    expect(memory.state.pane).toBe("memory");

    const save = handleTuiInput(state(), data(), "s", { defaultWorkspaceName: "layout" });
    expect(save.state.mode).toBe("save-workspace");
  });

  it("renders the interactive help overlay", () => {
    const screen = renderTui(state({ mode: "help" }), data(), {
      columns: 100,
      rows: 20,
    });
    expect(screen).toContain("Shortcuts");
    expect(screen).toContain("Cycle theme");
    expect(screen).toContain("Save current open live layout");
    expect(screen).toContain("memory source");
  });

  it("renders memory search results and details", () => {
    const screen = renderTui(state({ pane: "memory", query: "memory-aware" }), data(), {
      columns: 110,
      rows: 20,
    });
    expect(screen).toContain("Memory");
    expect(screen).toContain("Use terminal UI");
    expect(screen).toContain("Enter/o opens the source session");
  });

  it("enters search mode with the current query as editable text", () => {
    const result = handleTuiInput(state({ query: "repo" }), data(), "/", {
      defaultWorkspaceName: "layout",
    });
    expect(result.state.mode).toBe("search");
    expect(result.state.input).toBe("repo");
  });
});
