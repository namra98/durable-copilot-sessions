import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { SessionListResult } from "../core/manager.js";
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
  failList: boolean;

  constructor(failList = false) {
    this.failList = failList;
  }

  listSessionsResult(filter = "open"): SessionListResult {
    if (this.failList) {
      throw new Error("discovery failed");
    }
    this.filters.push(filter);
    return { sessions: [], openCount: 0 };
  }

  listWorkspaces(): Workspace[] {
    return [];
  }

  listSnapshots(): Workspace[] {
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
});
