import { spawnSync } from "node:child_process";
import os from "node:os";
import type {
  LaunchResult,
  ResumeOptions,
  TabSpec,
  WindowSpec,
  WindowTarget,
} from "../types.js";
import { renderLaunchScript, writeLaunchScript } from "./script.js";
import { buildWindowArgs, resolveLaunchCwd } from "./wt.js";

/**
 * High-level entry points that turn launch specs into running Windows Terminal
 * windows. The actual process spawn is injectable so callers (and tests) can
 * capture the `wt.exe` argv without launching anything.
 */

/** Result of a single `wt.exe` invocation. */
export interface ExecResult {
  status: number | null;
  error?: Error;
}

/** Injectable executor for `wt.exe`. */
export type ExecFn = (args: string[]) => ExecResult;

interface LauncherDeps {
  scriptDir?: string;
  exec?: ExecFn;
}

function defaultExec(args: string[]): ExecResult {
  const result = spawnSync("wt.exe", args, { windowsHide: false });
  return { status: result.status, error: result.error ?? undefined };
}

function isFailure(result: ExecResult): boolean {
  return Boolean(result.error) || (result.status !== null && result.status !== 0);
}

function execErrorMessage(result: ExecResult): string {
  return result.error?.message ?? `wt.exe exited with code ${result.status}`;
}

/**
 * Resume a single Copilot session in a new Windows Terminal tab. Renders and
 * writes a launch script, builds the one-window/one-tab argv, then (unless
 * `dryRun`) executes `wt.exe`.
 */
export function resumeSession(opts: ResumeOptions, deps: LauncherDeps = {}): LaunchResult {
  const warnings: string[] = [];
  const tab: TabSpec = {
    sessionId: opts.sessionId,
    title: opts.title ?? opts.sessionId.slice(0, 8),
    color: opts.color ?? "blue",
    cwd: opts.cwd ?? os.homedir(),
    copilotArgs: opts.copilotArgs,
  };
  const target: WindowTarget = opts.window ?? "new";

  const scriptPath = writeLaunchScript(renderLaunchScript(tab), deps.scriptDir);
  const args = buildWindowArgs(target, [{ spec: tab, scriptPath }]);

  if (opts.dryRun) {
    return { ok: true, tabsLaunched: 1, windowsOpened: 1, warnings };
  }

  const exec = deps.exec ?? defaultExec;
  const result = exec(args);
  if (isFailure(result)) {
    return {
      ok: false,
      tabsLaunched: 0,
      windowsOpened: 0,
      warnings,
      error: execErrorMessage(result),
    };
  }

  return { ok: true, tabsLaunched: 1, windowsOpened: 1, warnings };
}

/**
 * Launch one `wt.exe` per WindowSpec. Each window is opened as a new window,
 * except the first may reuse the current window when `opts.window === "current"`.
 * Aggregates tab/window counts and any cwd-substitution warnings.
 */
export function launchWindows(
  windows: WindowSpec[],
  opts: { window?: WindowTarget; dryRun?: boolean } & LauncherDeps = {},
): LaunchResult {
  const warnings: string[] = [];
  const exec = opts.exec ?? defaultExec;
  let tabsLaunched = 0;
  let windowsOpened = 0;

  for (let i = 0; i < windows.length; i++) {
    const win = windows[i];
    const target: WindowTarget = i === 0 && opts.window === "current" ? "current" : "new";

    const builtTabs = win.tabs.map((tab) => {
      const resolved = resolveLaunchCwd(tab);
      if (resolved.warning) {
        warnings.push(resolved.warning);
      }
      const spec: TabSpec = { ...tab, cwd: resolved.cwd };
      const scriptPath = writeLaunchScript(renderLaunchScript(spec), opts.scriptDir);
      return { spec, scriptPath };
    });

    const args = buildWindowArgs(target, builtTabs);

    if (!opts.dryRun) {
      const result = exec(args);
      if (isFailure(result)) {
        return {
          ok: false,
          tabsLaunched,
          windowsOpened,
          warnings,
          error: execErrorMessage(result),
        };
      }
    }

    tabsLaunched += builtTabs.length;
    windowsOpened += 1;
  }

  return { ok: true, tabsLaunched, windowsOpened, warnings };
}
