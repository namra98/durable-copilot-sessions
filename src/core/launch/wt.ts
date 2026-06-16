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

/** Best-effort synchronous check for an executable on PATH. */
function isExecutableOnPath(exe: string): boolean {
  const rawPath = process.env.PATH ?? process.env.Path ?? "";
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    try {
      if (fs.existsSync(path.join(dir, exe))) {
        return true;
      }
    } catch {
      // Ignore unreadable PATH entries.
    }
  }
  return false;
}

/** Prefer PowerShell 7 (`pwsh.exe`) when available, else Windows PowerShell. */
export function pickShell(): string {
  return isExecutableOnPath("pwsh.exe") ? "pwsh.exe" : "powershell.exe";
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
