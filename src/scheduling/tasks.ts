import os from "node:os";
import { log } from "../core/logger.js";
import {
  buildCreateLogonArgs,
  buildCreateSnapshotArgs,
  buildDeleteArgs,
  buildQueryArgs,
  defaultExec,
  LOGON_TASK_NAME,
  SNAPSHOT_TASK_NAME,
  type TaskExec,
  type TaskExecResult,
} from "./schtasks.js";
import {
  installStartupRestore,
  startupRestoreInstalled,
  STARTUP_RESTORE_SCRIPT_NAME,
  uninstallStartupRestore,
} from "./startup.js";

/**
 * High-level install/uninstall/status operations for Windows logon durability:
 *   - a periodic auto-snapshot Scheduled Task, and
 *   - logon restore-prompt automation via an ONLOGON Scheduled Task or, when
 *     Windows denies that trigger, a current-user Startup-folder fallback.
 *
 * Every operation routes through a {@link TaskExec} so tests can inject a fake
 * executor; the real {@link defaultExec} is used when none is provided.
 */

const LOG_SCOPE = "scheduling";

interface UserInfoLike {
  username: string;
}

export function defaultRunAsUser(
  env: NodeJS.ProcessEnv = process.env,
  userInfo: () => UserInfoLike = () => os.userInfo({ encoding: "utf8" }),
): string | undefined {
  let username: string | undefined;
  try {
    username = userInfo().username;
  } catch {
    username = undefined;
  }
  if (!username || username.length === 0) {
    username = env.USERNAME;
  }
  if (!username || username.length === 0) return undefined;
  if (username.includes("\\") || username.includes("@")) return username;
  const domain = env.USERDOMAIN;
  return domain && domain.length > 0 ? `${domain}\\${username}` : username;
}

/** Options controlling which commands the scheduled tasks run. */
export interface InstallOptions {
  /** Fully-resolved command line run by the periodic snapshot task. */
  snapshotCommand: string;
  /** Fully-resolved command line run by the logon restore-prompt task. */
  restorePromptCommand: string;
  /** Minutes between auto-snapshots. */
  intervalMinutes: number;
  /** Executor seam; defaults to the real `schtasks.exe` runner. */
  exec?: TaskExec;
  /** User principal for the ONLOGON task; defaults to the current Windows user. */
  runAsUser?: string;
  /** Startup folder override, exposed for hermetic tests. */
  startupDir?: string;
}

export interface TasksStatus {
  /** Periodic snapshot Scheduled Task is registered. */
  snapshot: boolean;
  /** Any logon restore mechanism is installed. */
  logon: boolean;
  /** ONLOGON restore Scheduled Task is registered. */
  logonTask: boolean;
  /** Current-user Startup-folder fallback is installed. */
  startupFallback: boolean;
}

/** Extract all text emitted by a `schtasks.exe` invocation. */
function resultText(result: TaskExecResult): string {
  return [result.stderr, result.stdout, result.error?.message]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join(" ");
}

/** Extract a human-readable failure detail from an executor result. */
function failureDetail(result: TaskExecResult): string {
  const detail = resultText(result);
  return detail.length > 0 ? detail : "unknown error";
}

/** Heuristic: did a delete/query fail only because the task does not exist? */
function isNotFound(result: TaskExecResult): boolean {
  const text = resultText(result);
  return /cannot find|does not exist|the system cannot find the (file|path)/i.test(
    text,
  );
}

/** Heuristic: did task creation fail because Windows denied this user's ACL? */
function isAccessDenied(result: TaskExecResult): boolean {
  const text = resultText(result);
  return /access is denied/i.test(text);
}

/**
 * Register the periodic snapshot task and logon restore automation. `logon`
 * means either the ONLOGON task was registered or the Startup fallback was
 * installed; messages include scheduler output for failures.
 */
export function installTasks(opts: InstallOptions): {
  snapshot: boolean;
  logon: boolean;
  messages: string[];
} {
  const exec = opts.exec ?? defaultExec;
  const messages: string[] = [];

  const snapshotResult = exec.run(
    buildCreateSnapshotArgs({
      command: opts.snapshotCommand,
      intervalMinutes: opts.intervalMinutes,
    }),
  );
  const snapshot = snapshotResult.status === 0;
  if (snapshot) {
    const msg = `Registered scheduled task ${SNAPSHOT_TASK_NAME} (snapshot every ${opts.intervalMinutes} min).`;
    messages.push(msg);
    log.info(msg, { scope: LOG_SCOPE, taskName: SNAPSHOT_TASK_NAME });
  } else {
    const msg = `Failed to register ${SNAPSHOT_TASK_NAME}: ${failureDetail(snapshotResult)}`;
    messages.push(msg);
    log.error(msg, {
      scope: LOG_SCOPE,
      taskName: SNAPSHOT_TASK_NAME,
      status: snapshotResult.status,
    });
  }

  const runAsUser = opts.runAsUser ?? defaultRunAsUser();
  if (!runAsUser) {
    const msg =
      `Failed to register ${LOGON_TASK_NAME}: could not determine current Windows user for /RU.`;
    messages.push(msg);
    log.error(msg, { scope: LOG_SCOPE, taskName: LOGON_TASK_NAME });
    return { snapshot, logon: false, messages };
  }

  const logonResult = exec.run(
    buildCreateLogonArgs({
      command: opts.restorePromptCommand,
      runAsUser,
    }),
  );
  let logon = logonResult.status === 0;
  if (logon) {
    const msg = `Registered scheduled task ${LOGON_TASK_NAME} (restore prompt at logon).`;
    messages.push(msg);
    log.info(msg, { scope: LOG_SCOPE, taskName: LOGON_TASK_NAME });
    try {
      if (uninstallStartupRestore(opts.startupDir)) {
        const cleanupMsg = `Removed stale Startup fallback ${STARTUP_RESTORE_SCRIPT_NAME}.`;
        messages.push(cleanupMsg);
        log.info(cleanupMsg, { scope: LOG_SCOPE, taskName: LOGON_TASK_NAME });
      }
    } catch (err) {
      const cleanupMsg = `Failed to remove stale Startup fallback ${STARTUP_RESTORE_SCRIPT_NAME}: ${
        (err as Error).message
      }`;
      messages.push(cleanupMsg);
      log.error(cleanupMsg, { scope: LOG_SCOPE, taskName: LOGON_TASK_NAME });
    }
  } else if (isAccessDenied(logonResult)) {
    try {
      const file = installStartupRestore(opts.restorePromptCommand, opts.startupDir);
      logon = true;
      const msg =
        `Windows denied ${LOGON_TASK_NAME}; installed current-user Startup fallback ` +
        `${STARTUP_RESTORE_SCRIPT_NAME} at ${file} instead.`;
      messages.push(msg);
      log.warn(msg, {
        scope: LOG_SCOPE,
        taskName: LOGON_TASK_NAME,
        fallbackPath: file,
        status: logonResult.status,
      });
    } catch (err) {
      const msg =
        `Failed to register ${LOGON_TASK_NAME}: ${failureDetail(logonResult)}; ` +
        `Startup fallback also failed: ${(err as Error).message}`;
      messages.push(msg);
      log.error(msg, {
        scope: LOG_SCOPE,
        taskName: LOGON_TASK_NAME,
        status: logonResult.status,
      });
    }
  } else {
    const msg = `Failed to register ${LOGON_TASK_NAME}: ${failureDetail(logonResult)}`;
    messages.push(msg);
    log.error(msg, {
      scope: LOG_SCOPE,
      taskName: LOGON_TASK_NAME,
      status: logonResult.status,
    });
  }

  return { snapshot, logon, messages };
}

/**
 * Remove the Scheduled Tasks and any Startup fallback. Missing entries are
 * treated as success so the operation is idempotent.
 */
export function uninstallTasks(opts?: { exec?: TaskExec; startupDir?: string }): {
  messages: string[];
} {
  const exec = opts?.exec ?? defaultExec;
  const messages: string[] = [];

  for (const taskName of [SNAPSHOT_TASK_NAME, LOGON_TASK_NAME]) {
    const result = exec.run(buildDeleteArgs(taskName));
    if (result.status === 0) {
      const msg = `Removed scheduled task ${taskName}.`;
      messages.push(msg);
      log.info(msg, { scope: LOG_SCOPE, taskName });
    } else if (isNotFound(result)) {
      const msg = `Scheduled task ${taskName} was not present.`;
      messages.push(msg);
      log.info(msg, { scope: LOG_SCOPE, taskName });
    } else {
      const msg = `Failed to remove ${taskName}: ${failureDetail(result)}`;
      messages.push(msg);
      log.error(msg, { scope: LOG_SCOPE, taskName, status: result.status });
    }
  }

  try {
    if (uninstallStartupRestore(opts?.startupDir)) {
      const msg = `Removed Startup fallback ${STARTUP_RESTORE_SCRIPT_NAME}.`;
      messages.push(msg);
      log.info(msg, { scope: LOG_SCOPE, taskName: LOGON_TASK_NAME });
    }
  } catch (err) {
    const msg = `Failed to remove Startup fallback ${STARTUP_RESTORE_SCRIPT_NAME}: ${
      (err as Error).message
    }`;
    messages.push(msg);
    log.error(msg, { scope: LOG_SCOPE, taskName: LOGON_TASK_NAME });
  }

  return { messages };
}

/**
 * Report Scheduled Task presence and Startup fallback presence separately, plus
 * overall logon restore readiness.
 */
export function tasksStatus(opts?: { exec?: TaskExec; startupDir?: string }): TasksStatus {
  const exec = opts?.exec ?? defaultExec;
  const snapshot = exec.run(buildQueryArgs(SNAPSHOT_TASK_NAME)).status === 0;
  const logonTask = exec.run(buildQueryArgs(LOGON_TASK_NAME)).status === 0;
  const startupFallback = startupRestoreInstalled(opts?.startupDir);
  return { snapshot, logon: logonTask || startupFallback, logonTask, startupFallback };
}
