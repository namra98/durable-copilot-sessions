import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Centralized filesystem locations for both the Copilot CLI state we read and
 * the durable-copilot-sessions state we own. All paths can be overridden via
 * environment variables to keep tests hermetic.
 */

const home = os.homedir();

/** Root of the Copilot CLI state we read from (never write to). */
export const copilotHome =
  process.env.DCS_COPILOT_HOME ?? path.join(home, ".copilot");

/** Directory containing one folder per Copilot session. */
export const copilotSessionStateDir = path.join(copilotHome, "session-state");

/** Global SQLite index of sessions (resume picker backing store). */
export const copilotSessionStoreDb = path.join(copilotHome, "session-store.db");

/** Root of the state this tool owns. Override with DCS_STATE_DIR for tests. */
export const stateDir =
  process.env.DCS_STATE_DIR ?? path.join(home, ".durable-copilot-sessions", "state");

export const registryDir = path.join(stateDir, "registry");
export const managedSessionsDir = path.join(registryDir, "sessions");
export const workspacesDir = path.join(registryDir, "workspaces");
export const snapshotsDir = path.join(stateDir, "snapshots");
export const logsDir = path.join(stateDir, "logs");
export const launchScriptsDir = path.join(stateDir, "launch-scripts");
export const configFile = path.join(stateDir, "config.json");
/** Writable SQLite DB for the local memory/recall layer (separate from Copilot's). */
export const memoryDb = path.join(stateDir, "memory.db");

/** Create every owned state directory if missing. Safe to call repeatedly. */
export function ensureStateDirs(): void {
  for (const dir of [
    stateDir,
    registryDir,
    managedSessionsDir,
    workspacesDir,
    snapshotsDir,
    logsDir,
    launchScriptsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Absolute path to a session's workspace.yaml. */
export function workspaceYamlPath(sessionId: string): string {
  return path.join(copilotSessionStateDir, sessionId, "workspace.yaml");
}
