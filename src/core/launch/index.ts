/**
 * Public API for the Windows Terminal launcher: color resolution, launch-script
 * generation, wt.exe argv builders, and the high-level resume/launch entry points.
 */
export { colorToHex } from "./colors.js";
export { renderLaunchScript, writeLaunchScript } from "./script.js";
export { pickShell, escapeWtValue, resolveLaunchCwd, buildWindowArgs } from "./wt.js";
export { resumeSession, launchWindows } from "./launcher.js";
export type { ExecFn, ExecResult } from "./launcher.js";
