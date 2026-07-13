#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "contracts");
const workspaceId = "workspace-morning";

const args = parseArgs(process.argv.slice(2));
const sampleCount = numberArg(args.samples, 3);
const largeSessions = numberArg(args.largeSessions, 200);
const staleLockSessions = numberArg(args.staleLockSessions, 10);
const outputDir = path.resolve(args.output ?? path.join(repoRoot, "benchmark-results"));
const baseRef = args.baseRef ?? "origin/main";
const skipBuild = Boolean(args.skipBuild);
const skipInstall = Boolean(args.skipInstall);
const keepWorktree = Boolean(args.keepWorktree);
const baseDir = args.baseDir ? path.resolve(args.baseDir) : undefined;
const scratchRoot = path.join(os.tmpdir(), `dcs-benchmark-${Date.now()}-${randomUUID()}`);
const baseWorktree = baseDir ?? path.join(scratchRoot, "base");

function usage() {
  return [
    "Usage: node devtools/benchmark-main-vs-rust.mjs [options]",
    "",
    "Options:",
    "  --base-ref <ref>          Base ref to compare against (default: origin/main)",
    "  --base-dir <path>         Existing built TypeScript/base checkout to reuse",
    "  --samples <n>             Samples per scenario after warmup (default: 3)",
    "  --large-sessions <n>      Synthetic idle sessions for discovery stress (default: 200)",
    "  --stale-lock-sessions <n> Synthetic stale-lock sessions for discovery stress (default: 10)",
    "  --output <dir>            Output directory (default: ./benchmark-results)",
    "  --skip-build              Do not build current/base implementations first",
    "  --skip-install            Do not run npm install in generated base worktree",
    "  --keep-worktree           Keep generated base worktree/scratch directory",
    "  --help                    Show this help",
  ].join("\n");
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

async function main() {
  ensureFixtures();
  fs.mkdirSync(outputDir, { recursive: true });
  if (!baseDir) {
    addBaseWorktree();
  }
  if (!skipBuild) {
    buildCurrent();
    buildBase();
  }

  const implementations = [
    {
      id: "main",
      label: "main TypeScript CLI",
      root: baseWorktree,
      command: ["node", path.join(baseWorktree, "dist", "cli", "index.js")],
    },
    {
      id: "rust-npm",
      label: "Rust via npm launcher",
      root: repoRoot,
      command: ["node", path.join(repoRoot, "dist", "cli", "rust-bin.js")],
    },
    {
      id: "rust-bin",
      label: "Rust direct binary",
      root: repoRoot,
      command: [path.join(repoRoot, "target", "dcs-release", "release", process.platform === "win32" ? "dcs-rs.exe" : "dcs-rs")],
    },
  ];

  const cli = runCliBenchmarks(implementations);
  const largeDiscovery = runLargeDiscoveryBenchmarks(implementations);
  const api = await runApiBenchmarks(implementations);
  const unsupportedCli = [
    {
      command: "resume <sessionId> API/CLI dry-run",
      main: "CLI supports dry-run through restore paths only; API resume would launch Windows Terminal",
      rust: "dry-run query supported on Rust API and CLI",
    },
    {
      command: "fork <sessionId>",
      main: "no dry-run/confirm gate on main; mutates Copilot state",
      rust: "supported with --dry-run and --confirm-copilot-state-write",
    },
    {
      command: "new <title>",
      main: "no safe dry-run option on main; would launch Windows Terminal",
      rust: "supported with --dry-run",
    },
    {
      command: "tray/install-tasks/uninstall-tasks/ui",
      main: "not benchmarked to avoid tray/UI launch or system task mutation",
      rust: "help/status/server behavior covered; install fallback is covered by Rust tests",
    },
  ];

  const result = {
    timestamp: new Date().toISOString(),
    baseRef,
    baseCommit: gitShort(baseWorktree),
    rustCommit: gitShort(repoRoot),
    methodology: [
      "Hermetic fixture state via DCS_COPILOT_HOME and DCS_STATE_DIR.",
      `CLI commands: 1 warmup + ${sampleCount} samples.`,
      "Safe write/dry-run commands use fresh copied fixture state per sample.",
      `Large discovery stress uses ${largeSessions} idle sessions and ${staleLockSessions} stale-lock sessions.`,
      "API endpoints run on random loopback ports and avoid routes that launch Windows Terminal or mutate scheduled tasks.",
    ].join(" "),
    cli,
    largeDiscovery,
    api,
    unsupportedCli,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `main-vs-rust-${stamp}.json`);
  const mdPath = path.join(outputDir, `main-vs-rust-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(result));
  console.log(`Saved JSON: ${jsonPath}`);
  console.log(`Saved summary: ${mdPath}`);
  printTopLine(result);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      throw new Error(`Unexpected argument: ${value}`);
    }
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (key === "help" || key === "skipBuild" || key === "skipInstall" || key === "keepWorktree") {
      parsed[key] = true;
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${value}`);
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function numberArg(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, got: ${value}`);
  }
  return parsed;
}

function ensureFixtures() {
  if (!fs.existsSync(path.join(fixtureDir, "copilot-home")) || !fs.existsSync(path.join(fixtureDir, "owned-state"))) {
    throw new Error(`Missing benchmark fixtures under ${fixtureDir}`);
  }
}

function addBaseWorktree() {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  fs.mkdirSync(scratchRoot, { recursive: true });
  run("git", ["worktree", "add", "--detach", baseWorktree, baseRef], repoRoot);
}

function buildCurrent() {
  console.log("Building current Rust implementation...");
  run("npm", ["run", "build:rust"], repoRoot);
  run("npm", ["run", "build:node"], repoRoot);
}

function buildBase() {
  console.log(`Preparing base implementation at ${baseWorktree}...`);
  if (!skipInstall && !fs.existsSync(path.join(baseWorktree, "node_modules"))) {
    run("npm", ["install", "--no-audit", "--no-fund"], baseWorktree);
  }
  run("npm", ["run", "build:node"], baseWorktree);
}

function runCliBenchmarks(implementations) {
  const readCases = [
    ["root --help", ["--help"], ["--help"]],
    ["ui --help", ["ui", "--help"], ["ui", "--help"]],
    ["serve --help", ["serve", "--help"], ["serve", "--help"]],
    ["list", ["list"], ["list"]],
    ["list --all", ["list", "--all"], ["list", "--all"]],
    ["list --tree", ["list", "--tree"], ["list", "--tree"]],
    ["stats", ["stats"], ["stats"]],
    ["logs --lines 5", ["logs", "--lines", "5"], ["logs", "--lines", "5"]],
    ["export-workspaces", ["export-workspaces"], ["export-workspaces"]],
    ["diff workspace", ["diff", workspaceId], ["diff", workspaceId]],
    ["clean read-only", ["clean"], ["clean"]],
    ["tasks-status", ["tasks-status"], ["tasks-status"]],
    ["doctor --json", ["doctor", "--json"], ["doctor", "--json"]],
    ["reindex-memory", ["reindex-memory"], ["reindex-memory"]],
    ["recall backend", ["recall", "backend"], ["recall", "backend"]],
  ];
  const writeCases = [
    ["restore workspace dry-run", ["restore", workspaceId, "--dry-run"], ["restore", workspaceId, "--dry-run"]],
    ["restore-last dry-run", ["restore-last", "--dry-run"], ["restore-last", "--dry-run"]],
    ["resume-repo dry-run", ["resume-repo", "durable-copilot-sessions", "--dry-run"], ["resume-repo", "durable-copilot-sessions", "--dry-run"]],
    ["snapshot", ["snapshot"], ["snapshot"]],
    ["save --all", ["save", "Bench Workspace", "--all", "--description", "benchmark"], ["save", "Bench Workspace", "--all", "--description", "benchmark"]],
    ["import-workspaces --fresh-ids", ["import-workspaces", path.join(fixtureDir, "workspace-export.v1.json"), "--fresh-ids"], ["import-workspaces", path.join(fixtureDir, "workspace-export.v1.json"), "--fresh-ids"]],
  ];

  const rows = [];
  for (const [name, baseArgs, rustArgs] of readCases) {
    for (const implementation of implementations) {
      const state = createState(`${name}-${implementation.id}-read`);
      const commandArgs = implementation.id === "main" ? baseArgs : rustArgs;
      runCli(implementation, commandArgs, state);
      const samples = Array.from({ length: sampleCount }, () => runCli(implementation, commandArgs, state));
      rows.push(resultRow("cli-read", name, implementation, commandArgs, samples));
      removeState(state);
    }
  }
  for (const [name, baseArgs, rustArgs] of writeCases) {
    for (const implementation of implementations) {
      const commandArgs = implementation.id === "main" ? baseArgs : rustArgs;
      const samples = [];
      for (let index = 0; index < sampleCount; index += 1) {
        const state = createState(`${name}-${implementation.id}-write-${index}`);
        samples.push(runCli(implementation, commandArgs, state));
        removeState(state);
      }
      rows.push(resultRow("cli-write-safe", name, implementation, commandArgs, samples));
    }
  }
  return rows;
}

function runLargeDiscoveryBenchmarks(implementations) {
  const rows = [];
  for (const [name, count, locks] of [
    [`${largeSessions} idle`, largeSessions, false],
    [`${staleLockSessions} stale-lock`, staleLockSessions, true],
  ]) {
    for (const implementation of implementations) {
      for (const commandArgs of [["list"], ["list", "--all"]]) {
        const state = createLargeState(`${implementation.id}-${name}`, count, locks);
        runCli(implementation, commandArgs, state, 45_000);
        const samples = Array.from({ length: sampleCount }, () => runCli(implementation, commandArgs, state, 45_000));
        rows.push(resultRow(`large-discovery-${name}`, commandArgs.join(" "), implementation, commandArgs, samples));
        removeState(state);
      }
    }
  }
  return rows;
}

async function runApiBenchmarks(implementations) {
  const apiImplementations = implementations.filter((implementation) => implementation.id !== "rust-npm");
  const apiCases = [
    ["GET health", "GET", "/api/health"],
    ["GET config", "GET", "/api/config"],
    ["GET sessions open", "GET", "/api/sessions?filter=open"],
    ["GET sessions all", "GET", "/api/sessions?filter=all"],
    ["GET graph open", "GET", "/api/graph?filter=open"],
    ["GET workspaces", "GET", "/api/workspaces"],
    ["GET snapshots", "GET", "/api/snapshots"],
    ["GET stats", "GET", "/api/stats"],
    ["GET logs", "GET", "/api/logs?lines=5"],
    ["GET memory recall", "GET", "/api/memory/recall"],
    ["POST snapshot", "POST", "/api/snapshot", "{}"],
    ["POST clean read-only", "POST", "/api/sessions/clean", "{}"],
  ];

  const rows = [];
  for (const implementation of apiImplementations) {
    const state = createState(`api-${implementation.id}`);
    const port = await freePort();
    const server = await startServer(implementation, state, port);
    try {
      rows.push({
        area: "api-cold-start",
        scenario: "serve until /api/health",
        impl: implementation.label,
        summary: summarize([{ exitCode: "0", ms: server.coldMs, timedOut: false, stdoutBytes: 0, stderrBytes: 0, stdoutPreview: "", stderrPreview: "" }]),
      });
      for (const [name, method, route, body] of apiCases) {
        const samples = [];
        for (let index = 0; index < sampleCount; index += 1) {
          samples.push(await httpCall(method, port, route, body));
        }
        rows.push({
          area: "api-endpoint",
          scenario: name,
          impl: implementation.label,
          method,
          path: route,
          summary: summarizeHttp(samples),
        });
      }
    } finally {
      server.process.kill();
      await onceExit(server.process);
      removeState(state);
    }
  }
  return rows;
}

function resultRow(area, scenario, implementation, commandArgs, samples) {
  return {
    area,
    scenario,
    impl: implementation.label,
    args: commandArgs.join(" "),
    summary: summarize(samples),
  };
}

function createState(label) {
  const root = path.join(scratchRoot, `state-${safeName(label)}-${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  copyDir(path.join(fixtureDir, "copilot-home"), path.join(root, "copilot-home"));
  copyDir(path.join(fixtureDir, "owned-state"), path.join(root, "state"));
  return {
    root,
    copilotHome: path.join(root, "copilot-home"),
    stateDir: path.join(root, "state"),
  };
}

function createLargeState(label, count, withLocks) {
  const root = path.join(scratchRoot, `large-${safeName(label)}-${Date.now()}-${randomUUID()}`);
  const sessionRoot = path.join(root, "copilot-home", "session-state");
  fs.mkdirSync(sessionRoot, { recursive: true });
  copyDir(path.join(fixtureDir, "owned-state"), path.join(root, "state"));
  const template = fs.readFileSync(
    path.join(fixtureDir, "copilot-home", "session-state", "11111111-1111-1111-1111-111111111111", "workspace.yaml"),
    "utf8",
  );
  for (let index = 0; index < count; index += 1) {
    const dir = path.join(sessionRoot, randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "workspace.yaml"), template.replace("Contract Primary", `Synthetic ${index}`));
    if (withLocks) {
      fs.writeFileSync(path.join(dir, "inuse.999999.lock"), "");
    }
  }
  return {
    root,
    copilotHome: path.join(root, "copilot-home"),
    stateDir: path.join(root, "state"),
  };
}

function runCli(implementation, commandArgs, state, timeout = 20_000) {
  const startedAt = performance.now();
  const result = spawnSync(implementation.command[0], [...implementation.command.slice(1), ...commandArgs], {
    cwd: implementation.root,
    env: {
      ...process.env,
      DCS_COPILOT_HOME: state.copilotHome,
      DCS_STATE_DIR: state.stateDir,
    },
    encoding: "utf8",
    errors: "replace",
    maxBuffer: 50 * 1024 * 1024,
    timeout,
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    exitCode: timedOut ? "timeout" : String(result.status ?? "error"),
    ms: roundMs(performance.now() - startedAt),
    timedOut,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stdoutPreview: compact(stdout).slice(0, 180),
    stderrPreview: compact(stderr).slice(0, 180),
  };
}

async function startServer(implementation, state, port) {
  const command = implementation.command;
  const child = spawn(command[0], [...command.slice(1), "serve", "--port", String(port)], {
    cwd: implementation.root,
    env: {
      ...process.env,
      DCS_COPILOT_HOME: state.copilotHome,
      DCS_STATE_DIR: state.stateDir,
    },
    stdio: "ignore",
  });
  const startedAt = performance.now();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      await response.arrayBuffer();
      if (response.status < 500) {
        return { process: child, coldMs: roundMs(performance.now() - startedAt) };
      }
    } catch {
      // Server still starting.
    }
    await sleep(100);
  }
  child.kill();
  throw new Error(`Server did not become ready: ${implementation.label}`);
}

async function httpCall(method, port, route, body) {
  const startedAt = performance.now();
  try {
    const options = {
      method,
      signal: AbortSignal.timeout(15_000),
      headers: {},
    };
    if (body !== undefined) {
      options.body = body;
      options.headers["Content-Type"] = "application/json";
    }
    const response = await fetch(`http://127.0.0.1:${port}${route}`, options);
    const text = await response.text();
    return {
      status: String(response.status),
      ms: roundMs(performance.now() - startedAt),
      timeout: false,
      bytes: Buffer.byteLength(text),
      preview: compact(text).slice(0, 120),
    };
  } catch (error) {
    return {
      status: "timeout/error",
      ms: roundMs(performance.now() - startedAt),
      timeout: true,
      bytes: 0,
      preview: String(error?.message ?? error).slice(0, 120),
    };
  }
}

function summarize(samples) {
  const timings = samples.map((sample) => sample.ms).sort((left, right) => left - right);
  return {
    avgMs: roundMs(timings.reduce((sum, value) => sum + value, 0) / timings.length),
    medianMs: timings[Math.floor(timings.length / 2)],
    minMs: timings[0],
    maxMs: timings[timings.length - 1],
    runs: samples.length,
    successes: samples.filter((sample) => sample.exitCode === "0").length,
    timeouts: samples.filter((sample) => sample.timedOut).length,
    exitCodes: [...new Set(samples.map((sample) => sample.exitCode))].sort().join(","),
    outputBytes: samples[0]?.stdoutBytes ?? 0,
    stderrBytes: samples[0]?.stderrBytes ?? 0,
    stdoutPreview: samples[0]?.stdoutPreview ?? "",
    stderrPreview: samples[0]?.stderrPreview ?? "",
  };
}

function summarizeHttp(samples) {
  const mapped = samples.map((sample) => ({
    exitCode: Number(sample.status) >= 200 && Number(sample.status) < 400 ? "0" : sample.status,
    ms: sample.ms,
    timedOut: sample.timeout,
    stdoutBytes: sample.bytes,
    stderrBytes: 0,
    stdoutPreview: sample.preview,
    stderrPreview: "",
  }));
  const summary = summarize(mapped);
  summary.exitCodes = [...new Set(samples.map((sample) => sample.status))].sort().join(",");
  summary.successes = samples.filter((sample) => Number(sample.status) >= 200 && Number(sample.status) < 400).length;
  return summary;
}

function renderMarkdown(result) {
  const sections = [
    ["CLI commands", result.cli],
    ["Large discovery stress", result.largeDiscovery],
    ["API server/endpoints", result.api],
  ];
  const lines = [
    "# Main vs Rust benchmark",
    "",
    `- Base ref: \`${result.baseRef}\``,
    `- Base commit: \`${result.baseCommit}\``,
    `- Rust commit: \`${result.rustCommit}\``,
    `- Methodology: ${result.methodology}`,
    "",
  ];
  for (const [title, rows] of sections) {
    lines.push(`## ${title}`, "");
    lines.push("| Scenario | Impl | Avg ms | Median ms | Min | Max | Success | Timeouts | Status |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const row of rows) {
      const summary = row.summary;
      lines.push(`| ${row.scenario} | ${row.impl} | ${summary.avgMs} | ${summary.medianMs} | ${summary.minMs} | ${summary.maxMs} | ${summary.successes}/${summary.runs} | ${summary.timeouts} | ${summary.exitCodes} |`);
    }
    lines.push("");
  }
  lines.push("## Unsupported without side effects", "");
  lines.push("| Command | Main | Rust |");
  lines.push("| --- | --- | --- |");
  for (const item of result.unsupportedCli) {
    lines.push(`| ${item.command} | ${item.main} | ${item.rust} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function printTopLine(result) {
  const interesting = new Set([
    "root --help",
    "list",
    "list --all",
    "stats",
    "restore workspace dry-run",
    "snapshot",
    "serve until /api/health",
    "GET sessions all",
    "GET graph open",
    "POST snapshot",
  ]);
  console.log("\nTop-line medians:");
  for (const row of [...result.cli, ...result.largeDiscovery, ...result.api]) {
    if (!interesting.has(row.scenario)) {
      continue;
    }
    const summary = row.summary;
    console.log(
      `${row.scenario.padEnd(30)} ${row.impl.padEnd(24)} median=${String(summary.medianMs).padStart(8)}ms success=${summary.successes}/${summary.runs} status=${summary.exitCodes}`,
    );
  }
}

function copyDir(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function removeState(state) {
  fs.rmSync(state.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function onceExit(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
  });
}

function run(file, commandArgs, cwd) {
  const command = commandInvocation(file, commandArgs);
  const result = spawnSync(command.file, command.args, {
    cwd,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    const detail = result.error ? ` (${result.error.message})` : "";
    throw new Error(`Command failed: ${file} ${commandArgs.join(" ")}${detail}`);
  }
}

function commandInvocation(file, commandArgs) {
  if (process.platform === "win32" && file === "npm") {
    return {
      file: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/c", "npm", ...commandArgs],
    };
  }
  return { file, args: commandArgs };
}

function gitShort(cwd) {
  return execFileSync("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function compact(value) {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

function safeName(value) {
  return value.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
}

function roundMs(value) {
  return Math.round(value * 10) / 10;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

process.on("exit", () => {
  if (!baseDir && !keepWorktree) {
    try {
      run("git", ["worktree", "remove", "--force", baseWorktree], repoRoot);
    } catch {
      // Best-effort cleanup; scratchRoot removal below handles partial worktrees.
    }
    fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
