import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Startup-folder fallback used when Windows denies ONLOGON task registration. */
export const STARTUP_RESTORE_SCRIPT_NAME = "DurableCopilotSessions-LogonRestore.vbs";

interface StartupDirDeps {
  knownFolder?: () => string | undefined;
  homeDir?: () => string;
}

function currentUserStartupKnownFolder(): string | undefined {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('Startup')"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) return undefined;
  const folder = result.stdout.trim();
  return folder.length > 0 ? folder : undefined;
}

function requireAbsoluteStartupDir(dir: string): string {
  if (!path.isAbsolute(dir)) {
    throw new Error(`Could not resolve an absolute Startup fallback path: ${dir}`);
  }
  return dir;
}

export function resolveStartupDir(deps: StartupDirDeps = {}): string {
  const knownFolder = deps.knownFolder ?? currentUserStartupKnownFolder;
  const knownDir = knownFolder();
  if (knownDir && knownDir.length > 0) return requireAbsoluteStartupDir(knownDir);

  const homeDir = deps.homeDir ?? (() => os.homedir());
  return requireAbsoluteStartupDir(
    path.join(homeDir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
  );
}

/** Resolve the current user's Startup folder without trusting mutable APPDATA. */
export function defaultStartupDir(): string {
  return resolveStartupDir();
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
  const hiddenWindowStyle = 0;
  const waitForCompletion = "False";
  const script =
    `CreateObject("WScript.Shell").Run "${escaped}", ` +
    `${hiddenWindowStyle}, ${waitForCompletion}\r\n`;
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
  try {
    return fs.statSync(startupRestoreScriptPath(dir)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
}
