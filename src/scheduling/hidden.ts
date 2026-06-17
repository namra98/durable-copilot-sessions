import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../core/paths.js";

/**
 * Generated VBScript launchers live here. Each shim runs a command with a fully
 * hidden window so the Scheduled Tasks never flash a console.
 */
export const launchersDir = path.join(stateDir, "launchers");

/**
 * Write a VBScript shim that runs `innerCommand` with a hidden window and return
 * the `wscript.exe` invocation that a Scheduled Task should use as its action.
 *
 * Running a console command directly from Task Scheduler briefly flashes a
 * console window on every trigger. Launching it through
 * `WScript.Shell.Run(cmd, 0, False)` (window style 0 = hidden) keeps it
 * completely invisible while still detaching immediately.
 *
 * @param name Stable base name for the `.vbs` file (e.g. "snapshot").
 * @param innerCommand Fully-quoted command line to run hidden.
 * @param dir Override the output directory (defaults to {@link launchersDir});
 *            exposed for hermetic tests.
 * @returns The `wscript.exe //B //Nologo "<path>"` action string.
 */
export function writeHiddenLauncher(
  name: string,
  innerCommand: string,
  dir: string = launchersDir,
): string {
  fs.mkdirSync(dir, { recursive: true });
  const vbsPath = path.join(dir, `${name}.vbs`);
  // Embedded double quotes in a VBScript string literal are escaped by doubling.
  const escaped = innerCommand.replace(/"/g, '""');
  const script = `CreateObject("WScript.Shell").Run "${escaped}", 0, False\r\n`;
  fs.writeFileSync(vbsPath, script, "utf8");
  return `wscript.exe //B //Nologo "${vbsPath}"`;
}
