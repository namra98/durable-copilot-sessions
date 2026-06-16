import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TabSpec } from "../types.js";
import { launchScriptsDir } from "../paths.js";

/**
 * Generation of the small PowerShell launch script that each Windows Terminal
 * tab runs to reattach a Copilot session. Session resume is cwd-scoped, so the
 * script must `Set-Location` to the recorded cwd before invoking copilot.
 */

/** Wrap a value in single quotes, doubling any embedded single quotes (PS rule). */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Render the PowerShell text that resumes one Copilot session. Pure: it performs
 * no I/O. The script self-deletes, hardens error handling, moves to the session
 * cwd, and runs `copilot [extraArgs...] --resume <sessionId>`.
 */
export function renderLaunchScript(tab: TabSpec): string {
  const extraArgs = (tab.copilotArgs ?? []).map(singleQuote);
  const copilotInvocation = ["& 'copilot'", ...extraArgs, "'--resume'", singleQuote(tab.sessionId)].join(
    " ",
  );

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "if ($PSCommandPath) { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }",
    `Set-Location -LiteralPath ${singleQuote(tab.cwd)}`,
    copilotInvocation,
    "",
  ];

  return lines.join("\r\n");
}

/**
 * Render the PowerShell text that starts a BRAND-NEW Copilot session. Pure. The
 * script self-deletes, moves to `cwd`, and runs `copilot` (optionally `-i
 * <prompt>` to seed the session, plus any extra args).
 */
export function renderNewSessionScript(
  cwd: string,
  prompt?: string,
  copilotArgs: string[] = [],
): string {
  const extraArgs = copilotArgs.map(singleQuote);
  const tail =
    prompt && prompt.trim()
      ? [...extraArgs, "'-i'", singleQuote(prompt)]
      : extraArgs;
  const copilotInvocation = ["& 'copilot'", ...tail].join(" ");

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "if ($PSCommandPath) { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }",
    `Set-Location -LiteralPath ${singleQuote(cwd)}`,
    copilotInvocation,
    "",
  ];

  return lines.join("\r\n");
}

/**
 * Write `content` to a uniquely-named `launch-<timestamp>-<uuid>.ps1` inside
 * `dir` (default: the owned launch-scripts directory), creating it if needed.
 * Returns the absolute path of the script.
 */
export function writeLaunchScript(content: string, dir: string = launchScriptsDir): string {
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `launch-${Date.now()}-${randomUUID()}.ps1`;
  const filePath = path.resolve(dir, fileName);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}
