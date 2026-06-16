#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { SessionManager } from "../core/manager.js";
import type { SessionView } from "../core/manager.js";
import type { LaunchResult, Workspace } from "../core/types.js";
import { startServer } from "../server/index.js";
import { ensureStateDirs } from "../core/paths.js";
import { log } from "../core/logger.js";
import { buildWindowArgs, writeLaunchScript } from "../core/launch/index.js";
import { installTasks, uninstallTasks, tasksStatus } from "../scheduling/index.js";

function tabCount(ws: Workspace): number {
  return ws.windows.reduce((n, w) => n + w.tabs.length, 0);
}

function printLaunch(result: LaunchResult): void {
  if (result.ok) {
    console.log(`OK — opened ${result.tabsLaunched} tab(s) in ${result.windowsOpened} window(s).`);
  } else {
    console.error(`Failed: ${result.error ?? "unknown error"}`);
    process.exitCode = 1;
  }
  for (const w of result.warnings) {
    console.warn(`  ! ${w}`);
  }
}

function printSessions(sessions: SessionView[]): void {
  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }
  const badge = (s: SessionView): string =>
    s.liveness === "live" ? "● live " : s.liveness === "stale" ? "○ stale" : "  idle ";
  for (const s of sessions) {
    const title = s.title ?? s.name ?? s.id.slice(0, 8);
    const repo = s.repository ? `${s.repository}${s.branch ? `@${s.branch}` : ""}` : "";
    console.log(`${badge(s)}  ${s.id.slice(0, 8)}  ${title}`);
    console.log(`          ${s.cwd}${repo ? `   [${repo}]` : ""}`);
  }
  console.log(`\n${sessions.length} session(s).`);
}

/** PowerShell launch script for a brand-new (non-resume) Copilot session. */
function renderNewSessionScript(cwd: string, prompt?: string): string {
  const q = (v: string): string => `'${v.replace(/'/g, "''")}'`;
  const lines = [
    "$launchScriptPath = $PSCommandPath",
    'if ($launchScriptPath) { Remove-Item -LiteralPath $launchScriptPath -Force -ErrorAction Continue }',
    '$ErrorActionPreference = "Stop"',
    `Set-Location -LiteralPath ${q(cwd)}`,
  ];
  if (prompt && prompt.trim() !== "") {
    lines.push(`& 'copilot' '-i' ${q(prompt)}`);
  } else {
    lines.push("& 'copilot'");
  }
  return lines.join("\r\n") + "\r\n";
}

function resolveCliCommand(sub: string): string {
  const cliEntry = fileURLToPath(import.meta.url);
  return `"${process.execPath}" "${cliEntry}" ${sub}`;
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("dcs")
    .description("Durable Copilot Sessions — save, snapshot, and one-click restore Copilot CLI sessions across Windows Terminal tabs.")
    .version("0.1.0");

  program
    .command("list")
    .description("List discovered Copilot sessions (live first)")
    .option("--all", "include inactive/idle sessions, not just live ones")
    .action((opts: { all?: boolean }) => {
      const mgr = new SessionManager();
      printSessions(mgr.listSessions(opts.all ? "all" : "live"));
    });

  program
    .command("resume <sessionId>")
    .description("Open a Windows Terminal tab that resumes a Copilot session")
    .option("--window <target>", "new | current", "new")
    .option("--color <color>", "tab color (name or #RRGGBB)")
    .option("--title <title>", "tab title")
    .action((sessionId: string, opts: { window?: "new" | "current"; color?: string; title?: string }) => {
      const mgr = new SessionManager();
      printLaunch(
        mgr.resume({ sessionId, window: opts.window, color: opts.color, title: opts.title }),
      );
    });

  program
    .command("save <name>")
    .description("Save the current live layout as a named workspace")
    .option("--all", "capture all discovered sessions, not just live ones")
    .option("--description <text>", "optional description")
    .action((name: string, opts: { all?: boolean; description?: string }) => {
      const mgr = new SessionManager();
      const ws = mgr.createWorkspace({
        name,
        fromLive: true,
        filter: opts.all ? "all" : "live",
        description: opts.description,
      });
      console.log(
        `Saved workspace "${ws.name}" (${ws.id}) — ${tabCount(ws)} tab(s) across ${ws.windows.length} window(s).`,
      );
    });

  program
    .command("restore <nameOrId>")
    .description("Relaunch a saved workspace's windows and tabs")
    .option("--window <target>", "new | current", "new")
    .option("--dry-run", "build commands without launching")
    .action((nameOrId: string, opts: { window?: "new" | "current"; dryRun?: boolean }) => {
      const mgr = new SessionManager();
      printLaunch(mgr.restoreByNameOrId(nameOrId, { window: opts.window, dryRun: opts.dryRun }));
    });

  program
    .command("snapshot")
    .description("Take a rolling auto-snapshot of the current live layout")
    .action(() => {
      const mgr = new SessionManager();
      const ws = mgr.snapshot();
      log.info("snapshot taken", {
        scope: "snapshot",
        id: ws.id,
        windows: ws.windows.length,
        tabs: tabCount(ws),
      });
      console.log(
        `Snapshot ${ws.id}: ${tabCount(ws)} live session(s) across ${ws.windows.length} window(s).`,
      );
    });

  program
    .command("restore-prompt")
    .description("On logon: if a recent snapshot exists, open the dashboard to restore it")
    .action(async () => {
      const mgr = new SessionManager();
      const latest = mgr.latestSnapshot();
      if (!latest) {
        console.log("No snapshot available to restore.");
        return;
      }
      console.log(
        `Last snapshot (${latest.createdAt}) has ${tabCount(latest)} session(s) across ${latest.windows.length} window(s).`,
      );
      const srv = await startServer({ openBrowser: true });
      console.log(`Open ${srv.url} to review and restore.`);
    });

  program
    .command("ui")
    .description("Start the local server and open the web dashboard")
    .option("--port <n>", "API port")
    .action(async (opts: { port?: string }) => {
      const srv = await startServer({
        openBrowser: true,
        port: opts.port ? Number(opts.port) : undefined,
      });
      console.log(`Dashboard: ${srv.url}  (Ctrl+C to stop)`);
    });

  program
    .command("serve")
    .description("Start the local API server (no browser)")
    .option("--port <n>", "API port")
    .action(async (opts: { port?: string }) => {
      const srv = await startServer({
        openBrowser: false,
        port: opts.port ? Number(opts.port) : undefined,
      });
      console.log(`API listening: ${srv.url}  (Ctrl+C to stop)`);
    });

  program
    .command("new <title>")
    .description("Launch a brand-new managed Copilot session in a Windows Terminal tab")
    .option("--cwd <dir>", "working directory", process.cwd())
    .option("--color <color>", "tab color", "blue")
    .option("--prompt <text>", "initial prompt to submit")
    .action((title: string, opts: { cwd: string; color: string; prompt?: string }) => {
      const cwd = path.resolve(opts.cwd);
      const script = renderNewSessionScript(cwd, opts.prompt);
      const scriptPath = writeLaunchScript(script);
      const args = buildWindowArgs("new", [
        { spec: { sessionId: "new", title, color: opts.color, cwd }, scriptPath },
      ]);
      const r = spawnSync("wt.exe", args, { windowsHide: false });
      if (r.status === 0) {
        console.log(`Launched new session "${title}" in ${cwd}.`);
      } else {
        console.error(`Failed to launch wt.exe: ${r.error?.message ?? `exit ${r.status}`}`);
        process.exitCode = 1;
      }
    });

  program
    .command("install-tasks")
    .description("Register Windows Scheduled Tasks: periodic snapshot + logon restore prompt")
    .option("--interval <minutes>", "snapshot interval in minutes", "5")
    .action((opts: { interval: string }) => {
      const res = installTasks({
        snapshotCommand: resolveCliCommand("snapshot"),
        restorePromptCommand: resolveCliCommand("restore-prompt"),
        intervalMinutes: Number(opts.interval),
      });
      for (const m of res.messages) console.log(m);
    });

  program
    .command("uninstall-tasks")
    .description("Remove the durable-copilot-sessions Scheduled Tasks")
    .action(() => {
      const res = uninstallTasks();
      for (const m of res.messages) console.log(m);
    });

  program
    .command("tasks-status")
    .description("Show whether the Scheduled Tasks are installed")
    .action(() => {
      const s = tasksStatus();
      console.log(`Snapshot task:      ${s.snapshot ? "installed" : "not installed"}`);
      console.log(`Logon restore task: ${s.logon ? "installed" : "not installed"}`);
    });

  return program;
}

ensureStateDirs();
buildProgram().parseAsync(process.argv).catch((err) => {
  log.error("cli error", {
    scope: "cli",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
