import { spawnSync } from "node:child_process";
import os from "node:os";
import type {
  LaunchResult,
  ResumeOptions,
  TabSpec,
  WindowSpec,
  WindowTarget,
} from "../types.js";
import { renderLaunchScript, renderNewSessionScript, writeLaunchScript } from "./script.js";
import { buildWindowArgs, resolveExecutable, resolveLaunchCwd } from "./wt.js";
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

/** Injectable executable resolver (defaults to the PATHEXT-aware resolver). */
export type ResolveFn = (name: string) => string | undefined;

interface LauncherDeps {
  scriptDir?: string;
  exec?: ExecFn;
  resolve?: ResolveFn;
}

const WT_NOT_FOUND = "Windows Terminal (wt.exe) was not found on PATH";
const COPILOT_NOT_FOUND =
  "copilot CLI was not found on PATH; the resumed tab may fail to start Copilot.";

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
 * Launch preflight: confirm `wt` and `copilot` resolve. A missing `wt` is fatal
 * (the spawn cannot succeed); a missing `copilot` is a non-fatal warning since
 * the script may still find it via a profile or shim at runtime.
 */
function checkLaunchExecutables(resolve: ResolveFn): {
  wtMissing: boolean;
  copilotWarning?: string;
} {
  return {
    wtMissing: !resolve("wt"),
    copilotWarning: resolve("copilot") ? undefined : COPILOT_NOT_FOUND,
  };
}

/**
 * Resume a single Copilot session in a new Windows Terminal tab. Renders and
 * writes a launch script, builds the one-window/one-tab argv, then (unless
 * `dryRun`) executes `wt.exe`.
 */
export function resumeSession(opts: ResumeOptions, deps: LauncherDeps = {}): LaunchResult {
  const warnings: string[] = [];
  const resolved = resolveLaunchCwd({ cwd: opts.cwd ?? os.homedir() }, opts.fallbacks ?? []);
  if (resolved.warning) {
    warnings.push(resolved.warning);
  }
  const tab: TabSpec = {
    sessionId: opts.sessionId,
    title: opts.title ?? opts.sessionId.slice(0, 8),
    color: opts.color ?? "blue",
    cwd: resolved.cwd,
    copilotArgs: opts.copilotArgs,
  };
  const target: WindowTarget = opts.window ?? "new";

  const resolve = deps.resolve ?? ((name: string) => resolveExecutable(name));
  const { wtMissing, copilotWarning } = checkLaunchExecutables(resolve);
  if (copilotWarning) {
    warnings.push(copilotWarning);
  }

  const scriptPath = writeLaunchScript(renderLaunchScript(tab), deps.scriptDir);
  const args = buildWindowArgs(target, [{ spec: tab, scriptPath }]);

  if (opts.dryRun) {
    return { ok: true, tabsLaunched: 1, windowsOpened: 1, warnings };
  }

  if (wtMissing) {
    return {
      ok: false,
      tabsLaunched: 0,
      windowsOpened: 0,
      warnings,
      error: WT_NOT_FOUND,
    };
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

/** Options for launching a brand-new Copilot session. */
export interface NewSessionOptions {
  title: string;
  cwd: string;
  color?: string;
  prompt?: string;
  window?: WindowTarget;
  copilotArgs?: string[];
  dryRun?: boolean;
}

/** Launch a brand-new (non-resume) Copilot session in a new Windows Terminal tab. */
export function launchNewSession(opts: NewSessionOptions, deps: LauncherDeps = {}): LaunchResult {
  const warnings: string[] = [];
  const resolved = resolveLaunchCwd({ cwd: opts.cwd });
  if (resolved.warning) {
    warnings.push(resolved.warning);
  }
  const spec: TabSpec = {
    sessionId: "new",
    title: opts.title,
    color: opts.color ?? "blue",
    cwd: resolved.cwd,
  };
  const target: WindowTarget = opts.window ?? "new";

  const resolve = deps.resolve ?? ((name: string) => resolveExecutable(name));
  const { wtMissing, copilotWarning } = checkLaunchExecutables(resolve);
  if (copilotWarning) {
    warnings.push(copilotWarning);
  }

  const scriptPath = writeLaunchScript(
    renderNewSessionScript(resolved.cwd, opts.prompt, opts.copilotArgs ?? []),
    deps.scriptDir,
  );
  const args = buildWindowArgs(target, [{ spec, scriptPath }]);

  if (opts.dryRun) {
    return { ok: true, tabsLaunched: 1, windowsOpened: 1, warnings };
  }
  if (wtMissing) {
    return { ok: false, tabsLaunched: 0, windowsOpened: 0, warnings, error: WT_NOT_FOUND };
  }
  const exec = deps.exec ?? defaultExec;
  const result = exec(args);
  if (isFailure(result)) {
    return { ok: false, tabsLaunched: 0, windowsOpened: 0, warnings, error: execErrorMessage(result) };
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
  const resolve = opts.resolve ?? ((name: string) => resolveExecutable(name));
  let tabsLaunched = 0;
  let windowsOpened = 0;

  const { wtMissing, copilotWarning } = checkLaunchExecutables(resolve);
  if (copilotWarning) {
    warnings.push(copilotWarning);
  }
  if (wtMissing && !opts.dryRun) {
    return {
      ok: false,
      tabsLaunched: 0,
      windowsOpened: 0,
      warnings,
      error: WT_NOT_FOUND,
    };
  }

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
