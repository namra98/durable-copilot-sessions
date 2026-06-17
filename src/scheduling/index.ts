/**
 * Public API for the scheduling module: build and manage the Windows Scheduled
 * Tasks that keep a Copilot session layout durable across reboots.
 */

export {
  SNAPSHOT_TASK_NAME,
  LOGON_TASK_NAME,
  defaultExec,
  buildCreateSnapshotArgs,
  buildCreateLogonArgs,
  buildDeleteArgs,
  buildQueryArgs,
} from "./schtasks.js";
export type { TaskExec, TaskExecResult } from "./schtasks.js";

export { installTasks, uninstallTasks, tasksStatus } from "./tasks.js";
export type { InstallOptions } from "./tasks.js";
export { writeHiddenLauncher, launchersDir } from "./hidden.js";
