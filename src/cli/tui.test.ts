import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { SessionListResult, SessionView } from "../core/manager.js";
import type { LaunchResult, MemorySearchHit, ResumeOptions, Workspace } from "../core/types.js";
import { runTui, type TuiInput, type TuiIo, type TuiManager, type TuiOutput } from "./tui.js";

class FakeInput extends EventEmitter implements TuiInput {
  isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
  }

  resume(): void {
    // No-op for tests.
  }
}

class FakeOutput extends EventEmitter implements TuiOutput {
  isTTY = true;
  columns = 100;
  rows = 30;
  chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

class FakeManager implements TuiManager {
  readonly filters: string[] = [];
  readonly createInputs: Array<Parameters<TuiManager["createWorkspace"]>[0]> = [];
  readonly memoryQueries: string[] = [];
  readonly resumedSessions: string[] = [];
  workspaceReads = 0;
  snapshotReads = 0;
  sessionResult: SessionListResult = { sessions: [], openCount: 0 };
  failList: boolean;

  constructor(failList = false) {
    this.failList = failList;
  }

  listSessionsResult(filter = "open"): SessionListResult {
    if (this.failList) {
      throw new Error("discovery failed");
    }
    this.filters.push(filter);
    return this.sessionResult;
  }

  listWorkspaces(): Workspace[] {
    this.workspaceReads += 1;
    return [];
  }

  listSnapshots(): Workspace[] {
    this.snapshotReads += 1;
    return [];
  }

  resume(options: ResumeOptions): LaunchResult {
    this.resumedSessions.push(options.sessionId);
    return { ok: true, tabsLaunched: 1, windowsOpened: 1, warnings: [] };
  }

  restoreWorkspace(): LaunchResult {
    return { ok: true, tabsLaunched: 1, windowsOpened: 1, warnings: [] };
  }

  snapshot(): Workspace {
    return workspace("snapshot");
  }

  createWorkspace(input: Parameters<TuiManager["createWorkspace"]>[0]): Workspace {
    this.createInputs.push(input);
    return workspace(input.name);
  }

  searchMemory(query: string): MemorySearchHit[] {
    this.memoryQueries.push(query);
    return [
      {
        memory: {
          id: "memory-1",
          sessionId: "memory-session",
          kind: "decision",
          title: "Memory hit",
          content: "Memory content",
          sourceTable: "checkpoints",
          createdAt: Date.parse("2026-07-09T00:00:00.000Z"),
          updatedAt: Date.parse("2026-07-09T00:00:00.000Z"),
        },
        score: 1,
      },
    ];
  }
}

function workspace(name: string): Workspace {
  return {
    id: name,
    name,
    source: "manual",
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    windows: [],
  };
}

function sessionView(id: string, name: string): SessionView {
  return {
    id,
    name,
    cwd: `C:\\repo\\${name}`,
    cwdExists: true,
    liveness: "live",
    livePids: [123],
    topLevel: true,
    managed: false,
  };
}

interface FakeIo extends TuiIo {
  stdin: FakeInput;
  stdout: FakeOutput;
}

function fakeIo(): FakeIo {
  return {
    stdin: new FakeInput(),
    stdout: new FakeOutput(),
  };
}

describe("runTui", () => {
  it("rejects non-interactive terminals", async () => {
    const io = fakeIo();
    io.stdin.isTTY = false;
    await expect(runTui(new FakeManager(), io)).rejects.toThrow("interactive terminal");
    expect(io.stdin.isRaw).toBe(false);
  });

  it("restores terminal mode after Ctrl+C", async () => {
    const io = fakeIo();
    const promise = runTui(new FakeManager(), io);
    expect(io.stdin.isRaw).toBe(true);

    io.stdin.emit("data", "\u0003");
    await promise;

    expect(io.stdin.isRaw).toBe(false);
    expect(io.stdout.chunks.join("")).toContain("\x1b[?1049l");
    expect(io.stdout.chunks.join("")).toContain("\x1b[?1000h");
    expect(io.stdout.chunks.join("")).toContain("\x1b[?1006h");
    expect(io.stdout.chunks.join("")).toContain("\x1b[?1000l");
    expect(io.stdout.chunks.join("")).toContain("\x1b[?1006l");
  });

  it("restores terminal mode if startup refresh fails", async () => {
    const io = fakeIo();
    await expect(runTui(new FakeManager(true), io)).rejects.toThrow("discovery failed");
    expect(io.stdin.isRaw).toBe(false);
    expect(io.stdout.chunks.join("")).toContain("\x1b[?1049l");
  });

  it("saves only the open live layout regardless of visible filter", async () => {
    const io = fakeIo();
    const manager = new FakeManager();
    const promise = runTui(manager, io);

    io.stdin.emit("data", "f");
    io.stdin.emit("data", "w");
    io.stdin.emit("data", "\r");
    io.stdin.emit("data", "\u0003");
    await promise;

    expect(manager.filters).toContain("live");
    expect(manager.createInputs).toHaveLength(1);
    expect(manager.createInputs[0].filter).toBe("open");
  });

  it("searches memory and opens the selected memory source", async () => {
    const io = fakeIo();
    const manager = new FakeManager();
    const promise = runTui(manager, io);

    io.stdin.emit("data", "/");
    io.stdin.emit("data", "decision");
    io.stdin.emit("data", "\r");
    io.stdin.emit("data", "m");
    io.stdin.emit("data", "o");
    io.stdin.emit("data", "\u0003");
    await promise;

    expect(manager.memoryQueries).toContain("decision");
    expect(manager.resumedSessions).toContain("memory-session");
  });

  it("redraws live search without clearing the whole screen", async () => {
    const io = fakeIo();
    const promise = runTui(new FakeManager(), io);
    const startupChunks = io.stdout.chunks.length;

    io.stdin.emit("data", "/");
    io.stdin.emit("data", "streamliner");
    io.stdin.emit("data", "\u0003");
    await promise;

    const output = io.stdout.chunks.join("");
    const searchRedraw = io.stdout.chunks.slice(startupChunks).join("");
    expect(output).not.toContain("\x1b[2J");
    expect(output).toContain("\x1b[H");
    expect(searchRedraw).not.toContain("\x1b[H");
    expect(searchRedraw).toContain("\x1b[");
    expect(searchRedraw).toContain(";1H");
  });

  it("filters live search locally without refreshing discovery on each keystroke", async () => {
    const io = fakeIo();
    const manager = new FakeManager();
    const promise = runTui(manager, io);

    io.stdin.emit("data", "/");
    for (const character of "streamliner") {
      io.stdin.emit("data", character);
    }
    expect(manager.filters).toEqual(["open"]);
    expect(manager.memoryQueries).toEqual([]);

    io.stdin.emit("data", "\u0003");
    await promise;
  });

  it("refreshes only sessions when cycling filters", async () => {
    const io = fakeIo();
    const manager = new FakeManager();
    const promise = runTui(manager, io);

    expect(manager.workspaceReads).toBe(1);
    expect(manager.snapshotReads).toBe(1);
    io.stdin.emit("data", "f");
    expect(manager.filters).toEqual(["open", "live"]);
    expect(manager.workspaceReads).toBe(1);
    expect(manager.snapshotReads).toBe(1);
    io.stdin.emit("data", "f");
    io.stdin.emit("data", "f");
    expect(manager.filters).toEqual(["open", "live", "all"]);

    io.stdin.emit("data", "\u0003");
    await promise;
  });

  it("debounces resize renders", async () => {
    vi.useFakeTimers();
    try {
      const io = fakeIo();
      const promise = runTui(new FakeManager(), io);
      const chunksAfterStart = io.stdout.chunks.length;

      io.stdout.columns = 101;
      io.stdout.emit("resize");
      io.stdout.emit("resize");
      expect(io.stdout.chunks).toHaveLength(chunksAfterStart);

      await vi.advanceTimersByTimeAsync(16);
      expect(io.stdout.chunks.length).toBeGreaterThan(chunksAfterStart);

      io.stdin.emit("data", "\u0003");
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("prewarms memory after the first render outside the search keystroke path", async () => {
    vi.useFakeTimers();
    try {
      const io = fakeIo();
      const manager = new FakeManager();
      const promise = runTui(manager, io);

      expect(manager.memoryQueries).toEqual([]);
      await vi.advanceTimersByTimeAsync(499);
      expect(manager.memoryQueries).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.memoryQueries).toEqual([""]);

      io.stdin.emit("data", "\u0003");
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("selects rows with mouse clicks before opening them", async () => {
    const io = fakeIo();
    const manager = new FakeManager();
    const first = sessionView("session-1", "one");
    const second = sessionView("session-2", "two");
    manager.sessionResult = { sessions: [first, second], openCount: 2 };
    const promise = runTui(manager, io);

    io.stdin.emit("data", "\x1b[<0;3;6M");
    io.stdin.emit("data", "\r");
    io.stdin.emit("data", "\u0003");
    await promise;

    expect(manager.resumedSessions).toContain("session-2");
  });

  it("copies selected references via OSC 52", async () => {
    const io = fakeIo();
    const manager = new FakeManager();
    manager.sessionResult = { sessions: [sessionView("copy-session", "copy")], openCount: 1 };
    const promise = runTui(manager, io);

    io.stdin.emit("data", "c");
    io.stdin.emit("data", "\u0003");
    await promise;

    expect(io.stdout.chunks.join("")).toContain(`\x1b]52;c;${Buffer.from("copy-session", "utf8").toString("base64")}\x07`);
  });
});
