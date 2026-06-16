#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../core/manager.js";
import type { SessionView } from "../core/manager.js";
import type { LaunchResult, Workspace } from "../core/types.js";
import { startServer } from "../server/index.js";
import { ensureStateDirs } from "../core/paths.js";
import { log } from "../core/logger.js";
import { installTasks, uninstallTasks, tasksStatus } from "../scheduling/index.js";
import { runDoctor } from "../core/doctor/index.js";

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

function printSessions(
  sessions: SessionView[],
  opts: { tree?: boolean; openCount?: number } = {},
): void {
  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }
  const badge = (s: SessionView): string =>
    s.liveness === "live" ? "● live " : s.liveness === "stale" ? "○ stale" : "  idle ";
  for (const s of sessions) {
    const title = s.title ?? s.name ?? s.id.slice(0, 8);
    const repo = s.repository ? `${s.repository}${s.branch ? `@${s.branch}` : ""}` : "";
    const child =
      opts.tree && s.role === "primary" && (s.childCount ?? 0) > 0 ? `  +${s.childCount}` : "";
    console.log(`${badge(s)}  ${s.id.slice(0, 8)}  ${title}${child}`);
    console.log(`          ${s.cwd}${repo ? `   [${repo}]` : ""}`);
  }
  if (opts.openCount !== undefined) {
    console.log(`\n${sessions.length} session(s); ${opts.openCount} open terminal(s).`);
  } else {
    console.log(`\n${sessions.length} session(s).`);
  }
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
    .description("List discovered Copilot sessions (open terminals by default)")
    .option("--live", "list all live sessions (flat), not just open primaries")
    .option("--all", "include inactive/idle sessions")
    .option("--tree", "show each open primary with a +N child-session indicator")
    .action((opts: { live?: boolean; all?: boolean; tree?: boolean }) => {
      const mgr = new SessionManager();
      const filter = opts.all ? "all" : opts.live ? "live" : "open";
      const result = mgr.listSessionsResult(filter);
      printSessions(result.sessions, { tree: opts.tree, openCount: result.openCount });
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
    .command("fork <sessionId>")
    .description("Branch a session into a new one (inherits history) via fork lineage")
    .option("--note <text>", "lineage note stored in the branch")
    .option("--launch", "open the new branch in a Windows Terminal tab")
    .option("--color <color>", "tab color for the launched branch")
    .option("--window <target>", "new | current", "new")
    .action((sessionId: string, opts: { note?: string; launch?: boolean; color?: string; window?: "new" | "current" }) => {
      const mgr = new SessionManager();
      const { fork, launch } = mgr.fork(sessionId, {
        note: opts.note,
        launch: opts.launch,
        color: opts.color,
        window: opts.window,
      });
      console.log(`Forked → ${fork.newSessionId}`);
      console.log(`  name: ${fork.newSessionName}`);
      console.log(`  path: ${fork.newSessionPath}`);
      if (launch) printLaunch(launch);
    });

  program
    .command("recall <query...>")
    .description("Search your local session memory (decisions, todos, summaries)")
    .option("--repo <repository>", "filter by repository")
    .option("--kind <kind>", "decision | todo | learning | summary | file_context")
    .option("--limit <n>", "max results", "10")
    .action((query: string[], opts: { repo?: string; kind?: string; limit: string }) => {
      const mgr = new SessionManager();
      const hits = mgr.searchMemory(query.join(" "), {
        repository: opts.repo,
        kind: opts.kind as never,
        limit: Number(opts.limit),
      });
      if (hits.length === 0) {
        console.log("No memories found. (Run `dcs reindex-memory` to build the index.)");
        return;
      }
      for (const hit of hits) {
        const m = hit.memory;
        console.log(`[${m.kind}] ${m.title ?? m.sessionId.slice(0, 8)}${m.repository ? `  (${m.repository})` : ""}`);
        console.log(`   ${hit.snippet ?? m.content.slice(0, 160)}`);
      }
      console.log(`\n${hits.length} memory result(s).`);
    });

  program
    .command("reindex-memory")
    .description("Rebuild the local memory index from your Copilot session history")
    .action(() => {
      const mgr = new SessionManager();
      const { count } = mgr.reindexMemory();
      console.log(`Indexed ${count} memories.`);
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
    .command("resume-repo <repository>")
    .description("Resume every OPEN session matching a repository as one grouped window")
    .option("--window <target>", "new | current", "new")
    .option("--dry-run", "build commands without launching")
    .action((repository: string, opts: { window?: "new" | "current"; dryRun?: boolean }) => {
      const mgr = new SessionManager();
      const needle = repository.toLowerCase();
      const matches = mgr.listSessions("open").filter((s) => {
        const haystack = [s.repository, s.gitRoot, s.cwd]
          .filter((v): v is string => typeof v === "string" && v.length > 0)
          .map((v) => v.toLowerCase());
        return haystack.some((v) => v.includes(needle));
      });
      if (matches.length === 0) {
        console.log(`No open sessions match "${repository}".`);
        return;
      }
      const ids = matches.map((s) => s.id);
      console.log(`Resuming ${ids.length} open session(s) matching "${repository}".`);
      printLaunch(mgr.resumeMany(ids, { window: opts.window, dryRun: opts.dryRun }));
    });

  program
    .command("restore-last")
    .description("Restore the most recent auto-snapshot")
    .option("--window <target>", "new | current", "new")
    .option("--dry-run", "build commands without launching")
    .action((opts: { window?: "new" | "current"; dryRun?: boolean }) => {
      const mgr = new SessionManager();
      const latest = mgr.latestSnapshot();
      if (!latest) {
        console.log("No snapshot available to restore. Take one with `dcs snapshot`.");
        return;
      }
      console.log(
        `Restoring last snapshot (${latest.createdAt}) — ${tabCount(latest)} session(s) across ${latest.windows.length} window(s).`,
      );
      printLaunch(mgr.restoreWorkspace(latest.id, { window: opts.window, dryRun: opts.dryRun }));
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
      const mgr = new SessionManager();
      const result = mgr.newSession({
        title,
        cwd: path.resolve(opts.cwd),
        color: opts.color,
        prompt: opts.prompt,
      });
      if (result.ok) {
        console.log(`Launched new session "${title}" in ${path.resolve(opts.cwd)}.`);
      } else {
        console.error(`Failed: ${result.error ?? "unknown error"}`);
        process.exitCode = 1;
      }
      for (const w of result.warnings) console.warn(`  ! ${w}`);
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

  program
    .command("doctor")
    .description("Run environment health checks (wt, PowerShell, copilot, Node, state dirs, tasks)")
    .option("--json", "output results as JSON")
    .action((opts: { json?: boolean }) => {
      const { checks, ok } = runDoctor();
      if (opts.json) {
        console.log(JSON.stringify({ ok, checks }, null, 2));
      } else {
        for (const c of checks) {
          console.log(`${c.ok ? "✓" : "✗"}  ${c.name} — ${c.detail}`);
        }
        console.log(`\n${ok ? "All checks passed." : "Some checks failed."}`);
      }
      if (!ok) {
        process.exitCode = 1;
      }
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
