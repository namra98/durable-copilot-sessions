import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
import { installStartupRestore, startupRestoreScriptPath } from "./startup.js";
import { defaultRunAsUser, installTasks, tasksStatus, uninstallTasks } from "./tasks.js";

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

function sequenceExec(results: TaskExecResult[]): {
  exec: TaskExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: TaskExec = {
    run(args: string[]): TaskExecResult {
      calls.push(args);
      return results[Math.min(calls.length - 1, results.length - 1)] ?? { status: 1 };
    },
  };
  return { exec, calls };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dcs-tasks-"));
}

describe("buildCreateSnapshotArgs", () => {
  it("produces a /Create DAILY schedule repeating every interval, indefinitely", () => {
    const args = buildCreateSnapshotArgs({
      command: "X snapshot",
      intervalMinutes: 5,
    });

    expect(args).toContain("/Create");
    expect(args).toContain("/SC");
    expect(args).toContain("DAILY");
    // Repeat every 5 minutes for a full day (avoids the /SC MINUTE 10-min cap).
    const riIndex = args.indexOf("/RI");
    expect(riIndex).toBeGreaterThan(-1);
    expect(args[riIndex + 1]).toBe("5");
    expect(args).toContain("/DU");
    expect(args[args.indexOf("/DU") + 1]).toBe("24:00");
    // Must NOT use the capped MINUTE schedule.
    expect(args).not.toContain("MINUTE");
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

  it("scopes an ONLOGON schedule to a run-as user when provided", () => {
    const args = buildCreateLogonArgs({
      command: "X restore-prompt",
      runAsUser: "DOMAIN\\namra",
    });

    expect(args).toContain("/RU");
    expect(args[args.indexOf("/RU") + 1]).toBe("DOMAIN\\namra");
    expect(args.indexOf("/RU")).toBeGreaterThan(args.indexOf("/TR"));
    expect(args.indexOf("/RU")).toBeLessThan(args.indexOf("/RL"));
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
  it("derives the default /RU principal from the current Windows user", () => {
    expect(
      defaultRunAsUser(
        { USERDOMAIN: "DOMAIN", USERNAME: "env-user" } as NodeJS.ProcessEnv,
        () => ({ username: "namra" }),
      ),
    ).toBe("DOMAIN\\namra");
  });

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

  it("passes the derived current user to the ONLOGON task by default", () => {
    const originalUsername = process.env.USERNAME;
    const originalDomain = process.env.USERDOMAIN;
    const userInfo = vi.spyOn(os, "userInfo").mockReturnValue({
      username: "namra",
      uid: -1,
      gid: -1,
      shell: null,
      homedir: "C:\\Users\\namra",
    });
    process.env.USERNAME = "env-user";
    process.env.USERDOMAIN = "DOMAIN";
    const { exec, calls } = recordingExec({ status: 0 });

    try {
      const result = installTasks({
        snapshotCommand: "X snapshot",
        restorePromptCommand: "X restore-prompt",
        intervalMinutes: 5,
        exec,
      });

      expect(result).toMatchObject({ snapshot: true, logon: true });
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain("/RU");
      expect(calls[1][calls[1].indexOf("/RU") + 1]).toBe("DOMAIN\\namra");
    } finally {
      userInfo.mockRestore();
      if (originalUsername === undefined) {
        delete process.env.USERNAME;
      } else {
        process.env.USERNAME = originalUsername;
      }
      if (originalDomain === undefined) {
        delete process.env.USERDOMAIN;
      } else {
        process.env.USERDOMAIN = originalDomain;
      }
    }
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

  it("does not create an unscoped ONLOGON task when the current user cannot be resolved", () => {
    const originalUsername = process.env.USERNAME;
    const originalDomain = process.env.USERDOMAIN;
    const userInfo = vi.spyOn(os, "userInfo").mockImplementation(() => {
      throw new Error("no user");
    });
    delete process.env.USERNAME;
    delete process.env.USERDOMAIN;
    const { exec, calls } = recordingExec({ status: 0 });

    try {
      const result = installTasks({
        snapshotCommand: "X snapshot",
        restorePromptCommand: "X restore-prompt",
        intervalMinutes: 5,
        exec,
      });

      expect(result).toMatchObject({ snapshot: true, logon: false });
      expect(calls).toHaveLength(1);
      expect(result.messages.some((m) => m.includes("could not determine current Windows user"))).toBe(
        true,
      );
    } finally {
      userInfo.mockRestore();
      if (originalUsername === undefined) {
        delete process.env.USERNAME;
      } else {
        process.env.USERNAME = originalUsername;
      }
      if (originalDomain === undefined) {
        delete process.env.USERDOMAIN;
      } else {
        process.env.USERDOMAIN = originalDomain;
      }
    }
  });

  it("falls back to the current-user Startup folder when logon task registration is denied", () => {
    const startupDir = tempDir();
    const { exec, calls } = sequenceExec([
      { status: 0 },
      { status: 1, stderr: "ERROR: Access is denied." },
    ]);

    const result = installTasks({
      snapshotCommand: "X snapshot",
      restorePromptCommand: "X restore-prompt",
      intervalMinutes: 5,
      exec,
      runAsUser: "DOMAIN\\namra",
      startupDir,
    });

    expect(result).toMatchObject({ snapshot: true, logon: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("/RU");
    expect(fs.existsSync(startupRestoreScriptPath(startupDir))).toBe(true);
    expect(result.messages.some((m) => m.includes("Startup fallback"))).toBe(true);
  });

  it("does not install the Startup fallback for non-permission logon failures", () => {
    const startupDir = tempDir();
    const { exec } = sequenceExec([{ status: 0 }, { status: 1, stderr: "bad trigger" }]);

    const result = installTasks({
      snapshotCommand: "X snapshot",
      restorePromptCommand: "X restore-prompt",
      intervalMinutes: 5,
      exec,
      runAsUser: "DOMAIN\\namra",
      startupDir,
    });

    expect(result).toMatchObject({ snapshot: true, logon: false });
    expect(fs.existsSync(startupRestoreScriptPath(startupDir))).toBe(false);
    expect(result.messages.some((m) => m.includes("bad trigger"))).toBe(true);
  });

  it("reports fallback write failures without marking logon restore installed", () => {
    const badStartupDir = path.join(tempDir(), "not-a-dir");
    fs.writeFileSync(badStartupDir, "file blocks mkdir");
    const { exec } = sequenceExec([
      { status: 0 },
      { status: 1, stderr: "ERROR: Access is denied." },
    ]);

    const result = installTasks({
      snapshotCommand: "X snapshot",
      restorePromptCommand: "X restore-prompt",
      intervalMinutes: 5,
      exec,
      runAsUser: "DOMAIN\\namra",
      startupDir: badStartupDir,
    });

    expect(result).toMatchObject({ snapshot: true, logon: false });
    expect(result.messages.some((m) => m.includes("Startup fallback also failed"))).toBe(true);
  });

  it("removes a stale Startup fallback after ONLOGON registration succeeds", () => {
    const startupDir = tempDir();
    installStartupRestore("X restore-prompt", startupDir);
    const { exec } = recordingExec({ status: 0 });

    const result = installTasks({
      snapshotCommand: "X snapshot",
      restorePromptCommand: "X restore-prompt",
      intervalMinutes: 5,
      exec,
      runAsUser: "DOMAIN\\namra",
      startupDir,
    });

    expect(result).toMatchObject({ snapshot: true, logon: true });
    expect(fs.existsSync(startupRestoreScriptPath(startupDir))).toBe(false);
    expect(result.messages.some((m) => m.includes("Removed stale Startup fallback"))).toBe(true);
  });

  it("reports stale Startup fallback cleanup failures without failing the ONLOGON task", () => {
    const startupDir = tempDir();
    fs.mkdirSync(startupRestoreScriptPath(startupDir));
    const { exec } = recordingExec({ status: 0 });

    const result = installTasks({
      snapshotCommand: "X snapshot",
      restorePromptCommand: "X restore-prompt",
      intervalMinutes: 5,
      exec,
      runAsUser: "DOMAIN\\namra",
      startupDir,
    });

    expect(result).toMatchObject({ snapshot: true, logon: true });
    expect(result.messages.some((m) => m.includes("Failed to remove stale Startup fallback"))).toBe(
      true,
    );
  });

  it("counts the Startup fallback as logon restore installed", () => {
    const startupDir = tempDir();
    installStartupRestore("X restore-prompt", startupDir);
    const { exec } = recordingExec({ status: 1, stderr: "not found" });

    expect(tasksStatus({ exec, startupDir })).toEqual({
      snapshot: false,
      logon: true,
      logonTask: false,
      startupFallback: true,
    });
  });

  it("reports the ONLOGON task separately when it exists without fallback", () => {
    const startupDir = tempDir();
    const { exec } = sequenceExec([{ status: 1 }, { status: 0 }]);

    expect(tasksStatus({ exec, startupDir })).toEqual({
      snapshot: false,
      logon: true,
      logonTask: true,
      startupFallback: false,
    });
  });

  it("removes the Startup fallback during uninstall", () => {
    const startupDir = tempDir();
    installStartupRestore("X restore-prompt", startupDir);
    const { exec } = recordingExec({
      status: 1,
      stderr: "ERROR: The system cannot find the file specified.",
    });

    const result = uninstallTasks({ exec, startupDir });

    expect(fs.existsSync(startupRestoreScriptPath(startupDir))).toBe(false);
    expect(result.messages.some((m) => m.includes("Removed Startup fallback"))).toBe(true);
  });

  it("reports scheduled-task delete failures during uninstall", () => {
    const { exec } = recordingExec({ status: 1, stderr: "delete failed" });

    const result = uninstallTasks({ exec, startupDir: tempDir() });

    expect(result.messages.filter((m) => m.includes("Failed to remove"))).toHaveLength(2);
    expect(result.messages.some((m) => m.includes("delete failed"))).toBe(true);
  });

  it("reports Startup fallback delete failures during uninstall", () => {
    const startupDir = tempDir();
    fs.mkdirSync(startupRestoreScriptPath(startupDir));
    const { exec } = recordingExec({
      status: 1,
      stderr: "ERROR: The system cannot find the file specified.",
    });

    const result = uninstallTasks({ exec, startupDir });

    expect(result.messages.some((m) => m.includes("Failed to remove Startup fallback"))).toBe(true);
  });
});
