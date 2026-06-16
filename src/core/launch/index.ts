/**
 * Public API for the Windows Terminal launcher: color resolution, launch-script
 * generation, wt.exe argv builders, and the high-level resume/launch entry points.
 */
export { colorToHex } from "./colors.js";
export { renderLaunchScript, renderNewSessionScript, writeLaunchScript } from "./script.js";
export { pickShell, escapeWtValue, resolveLaunchCwd, buildWindowArgs, resolveExecutable, preflight } from "./wt.js";
export { resumeSession, launchWindows, launchNewSession } from "./launcher.js";
export type { ExecFn, ExecResult, ResolveFn, NewSessionOptions } from "./launcher.js";
