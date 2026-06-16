import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveExecutable } from "../launch/wt.js";
import { copilotSessionStateDir, ensureStateDirs, stateDir } from "../paths.js";
import { tasksStatus } from "../../scheduling/index.js";

/**
 * Environment health checks for durable-copilot-sessions. Each check is a small
 * pure-ish unit that reports whether a prerequisite is satisfied plus a short
 * remediation detail. The process/filesystem bits are injectable so the
 * aggregation and formatting can be unit-tested without a real wt/copilot.
 */

/** One health-check result. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Injectable seams so checks can be exercised deterministically in tests. */
export interface DoctorDeps {
  /** Resolve an executable name to a path (defaults to the PATHEXT resolver). */
  resolve?: (name: string) => string | undefined;
  /** Node version string (defaults to process.versions.node). */
  nodeVersion?: string;
  /** Whether the experimental `node:sqlite` module loads. */
  hasSqlite?: () => boolean;
  /** Ensure the owned state directories exist. */
  ensureStateDirs?: () => void;
  /** Root state directory to probe for writability. */
  stateDir?: string;
  /** Copilot session-state directory to probe for readability. */
  sessionStateDir?: string;
  /** Returns true if `dir` is writable. */
  writeProbe?: (dir: string) => boolean;
  /** Returns true if `dir` is readable. */
  readProbe?: (dir: string) => boolean;
  /** Scheduled-task installation status. */
  tasksStatus?: () => { snapshot: boolean; logon: boolean };
}

const MIN_NODE_MAJOR = 20;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort: can the experimental built-in `node:sqlite` module load? */
function defaultHasSqlite(): boolean {
  // Suppress only Node's experimental-SQLite warning during the probe.
  const originalEmit = process.emitWarning.bind(process);
  const patched = (warning: string | Error, ...rest: unknown[]): void => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (/experimental/i.test(message) && /sqlite/i.test(message)) return;
    (originalEmit as (w: string | Error, ...a: unknown[]) => void)(warning, ...rest);
  };
  process.emitWarning = patched as typeof process.emitWarning;
  try {
    const req = createRequire(import.meta.url);
    const mod = req("node:sqlite") as { DatabaseSync?: unknown };
    return typeof mod.DatabaseSync === "function";
  } catch {
    return false;
  } finally {
    process.emitWarning = originalEmit;
  }
}

/** Write (and remove) a probe file to confirm a directory is writable. */
function defaultWriteProbe(dir: string): boolean {
  const probe = path.join(dir, `.dcs-doctor-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(probe, "ok");
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
  }
}

/** Confirm a directory is readable by listing it. */
function defaultReadProbe(dir: string): boolean {
  try {
    fs.readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

function checkWt(resolve: (name: string) => string | undefined): DoctorCheck {
  const found = resolve("wt");
  return {
    name: "Windows Terminal (wt.exe)",
    ok: Boolean(found),
    detail: found
      ? `found at ${found}`
      : "not found on PATH — install Windows Terminal and ensure wt.exe is on PATH.",
  };
}

function checkShell(resolve: (name: string) => string | undefined): DoctorCheck {
  const found = resolve("pwsh") ?? resolve("powershell");
  return {
    name: "PowerShell",
    ok: Boolean(found),
    detail: found
      ? `found at ${found}`
      : "no pwsh.exe or powershell.exe on PATH — install PowerShell 7 (pwsh).",
  };
}

function checkCopilot(resolve: (name: string) => string | undefined): DoctorCheck {
  const found = resolve("copilot");
  return {
    name: "Copilot CLI (copilot)",
    ok: Boolean(found),
    detail: found
      ? `found at ${found}`
      : "not found on PATH — install the Copilot CLI so resumed tabs can start it.",
  };
}

function checkNode(version: string): DoctorCheck {
  const major = Number(version.split(".")[0]);
  const ok = Number.isFinite(major) && major >= MIN_NODE_MAJOR;
  return {
    name: `Node.js >= ${MIN_NODE_MAJOR}`,
    ok,
    detail: ok
      ? `Node ${version}`
      : `Node ${version} is too old — upgrade to Node ${MIN_NODE_MAJOR} or newer.`,
  };
}

function checkSqlite(hasSqlite: () => boolean): DoctorCheck {
  const ok = hasSqlite();
  return {
    name: "node:sqlite",
    ok,
    detail: ok
      ? "available — session summaries can be enriched."
      : "not available (best-effort) — upgrade Node for built-in SQLite; summaries are skipped.",
  };
}

function checkStateDir(
  ensure: () => void,
  dir: string,
  writeProbe: (dir: string) => boolean,
): DoctorCheck {
  try {
    ensure();
  } catch {
    // Surface the failure via the write probe below.
  }
  const ok = writeProbe(dir);
  return {
    name: "State directory writable",
    ok,
    detail: ok ? `writable: ${dir}` : `cannot write to ${dir} — check permissions.`,
  };
}

function checkSessionState(dir: string, readProbe: (dir: string) => boolean): DoctorCheck {
  const ok = readProbe(dir);
  return {
    name: "Copilot session-state readable",
    ok,
    detail: ok
      ? `readable: ${dir}`
      : `cannot read ${dir} — is the Copilot CLI installed and has it run at least once?`,
  };
}

function checkTasks(statusFn: () => { snapshot: boolean; logon: boolean }): DoctorCheck {
  try {
    const status = statusFn();
    const ok = status.snapshot && status.logon;
    return {
      name: "Scheduled tasks",
      ok,
      detail: ok
        ? "snapshot + logon tasks installed."
        : `snapshot: ${status.snapshot ? "installed" : "missing"}, logon: ${
            status.logon ? "installed" : "missing"
          } — run \`dcs install-tasks\`.`,
    };
  } catch (err) {
    return {
      name: "Scheduled tasks",
      ok: false,
      detail: `could not query scheduled tasks: ${errorMessage(err)}`,
    };
  }
}

/** Aggregate a set of checks into an overall pass/fail result. */
export function aggregate(checks: DoctorCheck[]): { checks: DoctorCheck[]; ok: boolean } {
  return { checks, ok: checks.every((c) => c.ok) };
}

/**
 * Run all environment health checks. Returns the individual checks plus an
 * overall `ok` flag (false if any check failed). All external interactions are
 * injectable via {@link DoctorDeps}.
 */
export function runDoctor(deps: DoctorDeps = {}): { checks: DoctorCheck[]; ok: boolean } {
  const resolve = deps.resolve ?? ((name: string) => resolveExecutable(name));
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const hasSqlite = deps.hasSqlite ?? defaultHasSqlite;
  const ensure = deps.ensureStateDirs ?? ensureStateDirs;
  const stateDirPath = deps.stateDir ?? stateDir;
  const sessionStateDirPath = deps.sessionStateDir ?? copilotSessionStateDir;
  const writeProbe = deps.writeProbe ?? defaultWriteProbe;
  const readProbe = deps.readProbe ?? defaultReadProbe;
  const statusFn = deps.tasksStatus ?? (() => tasksStatus());

  const checks: DoctorCheck[] = [
    checkWt(resolve),
    checkShell(resolve),
    checkCopilot(resolve),
    checkNode(nodeVersion),
    checkSqlite(hasSqlite),
    checkStateDir(ensure, stateDirPath, writeProbe),
    checkSessionState(sessionStateDirPath, readProbe),
    checkTasks(statusFn),
  ];

  return aggregate(checks);
}
