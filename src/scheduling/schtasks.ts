import { spawnSync } from "node:child_process";

/**
 * Thin wrapper around the Windows `schtasks.exe` command. Argument builders are
 * pure so they can be unit-tested without touching the real Task Scheduler, and
 * execution is funneled through the {@link TaskExec} seam so callers (and tests)
 * can inject a fake executor instead of mutating the live system.
 */

/** Default name of the periodic auto-snapshot scheduled task. */
export const SNAPSHOT_TASK_NAME = "DurableCopilotSessions-Snapshot";

/** Default name of the logon restore-prompt scheduled task. */
export const LOGON_TASK_NAME = "DurableCopilotSessions-LogonRestore";

/** Result of a single `schtasks.exe` invocation. */
export interface TaskExecResult {
  /** Process exit code, or null if it could not be spawned. */
  status: number | null;
  /** Captured standard output, if any. */
  stdout?: string;
  /** Captured standard error, if any. */
  stderr?: string;
  /** Spawn error (e.g. executable not found), if any. */
  error?: Error;
}

/**
 * Execution seam for running `schtasks.exe`. Production code uses
 * {@link defaultExec}; tests inject a fake that records calls and returns
 * canned results so no real scheduled tasks are ever created.
 */
export interface TaskExec {
  run(args: string[]): TaskExecResult;
}

/** Real executor backed by `child_process.spawnSync("schtasks.exe", ...)`. */
export const defaultExec: TaskExec = {
  run(args: string[]): TaskExecResult {
    const result = spawnSync("schtasks.exe", args, { encoding: "utf8" });
    return {
      status: result.status,
      stdout: result.stdout ?? undefined,
      stderr: result.stderr ?? undefined,
      error: result.error,
    };
  },
};

/**
 * Build the `schtasks` arguments for the periodic auto-snapshot task that runs
 * `<command>` every `intervalMinutes` minutes. Pure: returns args only.
 *
 * `command` is passed to `/TR` verbatim: callers already quote the inner
 * executable/script paths, and `spawnSync` passes it as one argv element, so
 * wrapping it again would prepend an empty `""` token and break the action.
 */
export function buildCreateSnapshotArgs(opts: {
  command: string;
  intervalMinutes: number;
  taskName?: string;
}): string[] {
  const taskName = opts.taskName ?? SNAPSHOT_TASK_NAME;
  return [
    "/Create",
    "/TN",
    taskName,
    "/SC",
    "MINUTE",
    "/MO",
    String(opts.intervalMinutes),
    "/TR",
    opts.command,
    "/RL",
    "LIMITED",
    "/F",
  ];
}

/**
 * Build the `schtasks` arguments for the logon restore-prompt task that runs
 * `<command>` at user logon. Pure: returns args only.
 */
export function buildCreateLogonArgs(opts: {
  command: string;
  taskName?: string;
}): string[] {
  const taskName = opts.taskName ?? LOGON_TASK_NAME;
  return [
    "/Create",
    "/TN",
    taskName,
    "/SC",
    "ONLOGON",
    "/TR",
    opts.command,
    "/RL",
    "LIMITED",
    "/F",
  ];
}

/** Build the `schtasks` arguments to delete a task by name (forced). */
export function buildDeleteArgs(taskName: string): string[] {
  return ["/Delete", "/TN", taskName, "/F"];
}

/** Build the `schtasks` arguments to query a task by name. */
export function buildQueryArgs(taskName: string): string[] {
  return ["/Query", "/TN", taskName];
}
