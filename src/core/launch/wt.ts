import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TabSpec, WindowTarget } from "../types.js";
import { colorToHex } from "./colors.js";

/**
 * Windows Terminal argv construction. These helpers are pure (or best-effort
 * read-only) so the full `wt.exe` command can be unit-tested without launching
 * anything.
 */

/**
 * Default PATHEXT used when the environment does not provide one. Mirrors the
 * standard Windows ordering so that `.cmd`/`.exe`/`.ps1` shims resolve.
 */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PS1";

/**
 * Best-effort `where.exe` fallback used only against the real process
 * environment (an injected/temp env is searched purely on disk). Returns the
 * first hit, or undefined when the executable is not found.
 */
function whereExe(name: string): string | undefined {
  try {
    const res = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
    if (res.status === 0 && typeof res.stdout === "string") {
      const first = res.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return first;
    }
  } catch {
    // Ignore: where.exe missing or non-Windows host.
  }
  return undefined;
}

/**
 * Resolve an executable name to an absolute path, honoring PATHEXT so that
 * shims such as `copilot.cmd`, `copilot.exe`, or `copilot.ps1` (and `pwsh`)
 * are found even when the bare name has no extension. When the bare name
 * already carries an extension it is looked up verbatim. Falls back to
 * `where.exe` (first hit) when searching the real process environment.
 */
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const rawPath = env.PATH ?? env.Path ?? "";
  const dirs = rawPath.split(path.delimiter).filter((d) => d.length > 0);
  const hasExt = path.extname(name).length > 0;
  const exts = (env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter((e) => e.length > 0);
  const candidates = hasExt ? [name] : [...exts.map((ext) => name + ext), name];

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          // Return the real on-disk casing (PATHEXT entries are upper-case).
          try {
            return fs.realpathSync.native(full);
          } catch {
            return full;
          }
        }
      } catch {
        // Ignore unreadable PATH entries.
      }
    }
  }

  // Only consult where.exe for the real environment; an injected env is meant
  // to be searched hermetically on disk.
  if (env === process.env) {
    return whereExe(name);
  }
  return undefined;
}

/** Prefer PowerShell 7 (`pwsh.exe`) when available, else Windows PowerShell. */
export function pickShell(): string {
  return resolveExecutable("pwsh") ? "pwsh.exe" : "powershell.exe";
}

/**
 * Verify that the executables required to launch a tab are resolvable. Returns
 * the list of any missing names (`wt` and/or `copilot`).
 */
export function preflight(
  deps: { resolve?: (name: string) => string | undefined } = {},
): { ok: boolean; missing: string[] } {
  const resolve = deps.resolve ?? ((name: string) => resolveExecutable(name));
  const missing: string[] = [];
  if (!resolve("wt")) {
    missing.push("wt");
  }
  if (!resolve("copilot")) {
    missing.push("copilot");
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Escape a literal `;` inside a wt.exe argument *value* so Windows Terminal does
 * not treat it as a tab separator. The separator itself is a standalone token.
 */
export function escapeWtValue(v: string): string {
  return v.replace(/;/g, "\\;");
}

/**
 * Decide which directory to launch a tab in. Uses the tab's recorded cwd when it
 * exists, else the first existing fallback (e.g. the git root), else the user's
 * home directory. Returns a warning describing any substitution.
 */
export function resolveLaunchCwd(
  tab: { cwd: string },
  fallbacks: string[] = [],
): { cwd: string; warning?: string } {
  if (tab.cwd && fs.existsSync(tab.cwd)) {
    return { cwd: tab.cwd };
  }

  for (const fallback of fallbacks) {
    if (fallback && fs.existsSync(fallback)) {
      return {
        cwd: fallback,
        warning: `cwd "${tab.cwd}" does not exist; launching in "${fallback}" instead.`,
      };
    }
  }

  const home = os.homedir();
  return {
    cwd: home,
    warning: `cwd "${tab.cwd}" does not exist; launching in home directory "${home}" instead.`,
  };
}

/**
 * Build the full `wt.exe` argument array for ONE window containing the given
 * tabs. Pure. The first tab opens with `new-tab`; each subsequent tab is
 * preceded by a standalone `;` token (the wt tab separator).
 */
export function buildWindowArgs(
  target: WindowTarget,
  tabs: { spec: TabSpec; scriptPath: string }[],
): string[] {
  const shell = pickShell();
  const args: string[] = ["-w", target === "current" ? "0" : "-1"];

  tabs.forEach((tab, index) => {
    if (index > 0) {
      args.push(";");
    }
    args.push(
      "new-tab",
      "--title",
      escapeWtValue(tab.spec.title),
      "--suppressApplicationTitle",
      "--tabColor",
      colorToHex(tab.spec.color),
      "-d",
      escapeWtValue(tab.spec.cwd),
      shell,
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-NoExit",
      "-File",
      escapeWtValue(tab.scriptPath),
    );
  });

  return args;
}
