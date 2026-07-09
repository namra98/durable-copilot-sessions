import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Startup-folder fallback used when Windows denies ONLOGON task registration. */
export const STARTUP_RESTORE_SCRIPT_NAME = "DurableCopilotSessions-LogonRestore.vbs";

/** Resolve the current user's Startup folder without requiring elevation. */
export function defaultStartupDir(): string {
  const appData = process.env.APPDATA;
  const roaming =
    appData && appData.length > 0 ? appData : path.join(os.homedir(), "AppData", "Roaming");
  return path.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

export function startupRestoreScriptPath(dir: string = defaultStartupDir()): string {
  return path.join(dir, STARTUP_RESTORE_SCRIPT_NAME);
}

/** Install a hidden current-user logon launcher in the Startup folder. */
export function installStartupRestore(command: string, dir: string = defaultStartupDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = startupRestoreScriptPath(dir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const escaped = command.replace(/"/g, '""');
  const script = `CreateObject("WScript.Shell").Run "${escaped}", 0, False\r\n`;
  fs.writeFileSync(tmp, script, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

export function uninstallStartupRestore(dir: string = defaultStartupDir()): boolean {
  const file = startupRestoreScriptPath(dir);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export function startupRestoreInstalled(dir: string = defaultStartupDir()): boolean {
  return fs.existsSync(startupRestoreScriptPath(dir));
}
