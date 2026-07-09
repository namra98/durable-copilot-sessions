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
 * High-level install/uninstall/status operations for the two Windows Scheduled
 * Tasks that keep a Copilot session layout durable across reboots:
 *   - a periodic auto-snapshot task, and
 *   - a logon restore-prompt task.
 *
 * Every operation routes through a {@link TaskExec} so tests can inject a fake
 * executor; the real {@link defaultExec} is used when none is provided.
 */

const LOG_SCOPE = "scheduling";

function defaultRunAsUser(): string | undefined {
  const username = process.env.USERNAME;
  if (!username || username.length === 0) return undefined;
  const domain = process.env.USERDOMAIN;
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

/** Extract a human-readable failure detail from an executor result. */
function failureDetail(result: TaskExecResult): string {
  const detail = (result.stderr ?? result.error?.message ?? "").trim();
  return detail.length > 0 ? detail : "unknown error";
}

/** Heuristic: did a delete/query fail only because the task does not exist? */
function isNotFound(result: TaskExecResult): boolean {
  const text = `${result.stderr ?? ""} ${result.error?.message ?? ""}`;
  return /cannot find|does not exist|the system cannot find the (file|path)/i.test(
    text,
  );
}

/** Heuristic: did task creation fail because Windows denied this user's ACL? */
function isAccessDenied(result: TaskExecResult): boolean {
  const text = `${result.stderr ?? ""} ${result.error?.message ?? ""}`;
  return /access is denied/i.test(text);
}

/**
 * Register both scheduled tasks. Returns per-task success flags plus a list of
 * human-readable messages (including stderr for any failure) and logs each
 * outcome.
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

  const logonResult = exec.run(
    buildCreateLogonArgs({
      command: opts.restorePromptCommand,
      runAsUser: opts.runAsUser ?? defaultRunAsUser(),
    }),
  );
  let logon = logonResult.status === 0;
  if (logon) {
    const msg = `Registered scheduled task ${LOGON_TASK_NAME} (restore prompt at logon).`;
    messages.push(msg);
    log.info(msg, { scope: LOG_SCOPE, taskName: LOGON_TASK_NAME });
  } else if (isAccessDenied(logonResult)) {
    try {
      const file = installStartupRestore(opts.restorePromptCommand, opts.startupDir);
      logon = true;
      const msg =
        `Windows denied ${LOGON_TASK_NAME}; installed current-user Startup fallback ` +
        `${STARTUP_RESTORE_SCRIPT_NAME} instead.`;
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
 * Remove both scheduled tasks. A missing task is treated as success so the
 * operation is idempotent. Returns human-readable messages for each task.
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
 * Report whether each scheduled task currently exists, based on whether a
 * `schtasks /Query` for it exits successfully.
 */
export function tasksStatus(opts?: { exec?: TaskExec; startupDir?: string }): {
  snapshot: boolean;
  logon: boolean;
} {
  const exec = opts?.exec ?? defaultExec;
  const snapshot = exec.run(buildQueryArgs(SNAPSHOT_TASK_NAME)).status === 0;
  const logon =
    exec.run(buildQueryArgs(LOGON_TASK_NAME)).status === 0 ||
    startupRestoreInstalled(opts?.startupDir);
  return { snapshot, logon };
}
