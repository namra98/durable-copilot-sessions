import { describe, it, expect, vi } from "vitest";

// Mock the durable logger so tests never touch the real filesystem / home dir.
vi.mock("../core/logger.js", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  buildCreateSnapshotArgs,
  buildCreateLogonArgs,
  buildDeleteArgs,
  buildQueryArgs,
  type TaskExec,
  type TaskExecResult,
} from "./schtasks.js";
import { installTasks } from "./tasks.js";

/** Build a fake executor that records every call and returns a fixed result. */
function recordingExec(result: TaskExecResult): {
  exec: TaskExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: TaskExec = {
    run(args: string[]): TaskExecResult {
      calls.push(args);
      return result;
    },
  };
  return { exec, calls };
}

describe("buildCreateSnapshotArgs", () => {
  it("produces a /Create MINUTE schedule with interval, name, command and force", () => {
    const args = buildCreateSnapshotArgs({
      command: "X snapshot",
      intervalMinutes: 5,
    });

    expect(args).toContain("/Create");
    expect(args).toContain("/SC");
    expect(args).toContain("MINUTE");
    expect(args).toContain("/MO");
    expect(args).toContain("5");
    expect(args).toContain("/TN");
    expect(args).toContain("DurableCopilotSessions-Snapshot");
    expect(args).toContain("/TR");
    expect(args).toContain("/F");

    // The command is the value immediately after /TR, passed verbatim (the
    // caller already quotes inner paths; double-wrapping would break the action).
    const trIndex = args.indexOf("/TR");
    expect(args[trIndex + 1]).toBe("X snapshot");
    expect(args[trIndex + 1]).not.toMatch(/^"/);
  });

  it("honors a custom task name", () => {
    const args = buildCreateSnapshotArgs({
      command: "X snapshot",
      intervalMinutes: 15,
      taskName: "Custom-Snap",
    });
    expect(args).toContain("Custom-Snap");
    expect(args).not.toContain("DurableCopilotSessions-Snapshot");
  });
});

describe("buildCreateLogonArgs", () => {
  it("produces an ONLOGON schedule", () => {
    const args = buildCreateLogonArgs({ command: "X restore-prompt" });

    expect(args).toContain("/Create");
    expect(args).toContain("/SC");
    expect(args).toContain("ONLOGON");
    expect(args).toContain("/TN");
    expect(args).toContain("DurableCopilotSessions-LogonRestore");
    expect(args).toContain("/F");

    const trIndex = args.indexOf("/TR");
    expect(args[trIndex + 1]).toBe("X restore-prompt");
  });
});

describe("buildDeleteArgs / buildQueryArgs", () => {
  it("builds a forced delete by name", () => {
    expect(buildDeleteArgs("T")).toEqual(["/Delete", "/TN", "T", "/F"]);
  });

  it("builds a query by name", () => {
    expect(buildQueryArgs("T")).toEqual(["/Query", "/TN", "T"]);
  });
});

describe("installTasks", () => {
  it("registers both tasks via the injected executor on success", () => {
    const { exec, calls } = recordingExec({ status: 0 });

    const result = installTasks({
      snapshotCommand: "X snapshot",
      restorePromptCommand: "X restore-prompt",
      intervalMinutes: 5,
      exec,
    });

    expect(result).toMatchObject({ snapshot: true, logon: true });
    expect(calls).toHaveLength(2);
  });

  it("reports failure and surfaces stderr in messages", () => {
    const { exec } = recordingExec({ status: 1, stderr: "boom" });

    const result = installTasks({
      snapshotCommand: "X snapshot",
      restorePromptCommand: "X restore-prompt",
      intervalMinutes: 5,
      exec,
    });

    expect(result.snapshot).toBe(false);
    expect(result.logon).toBe(false);
    expect(result.messages.some((m) => m.includes("boom"))).toBe(true);
  });
});
