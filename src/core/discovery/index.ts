/**
 * Public surface of the session-discovery module: scan Copilot's on-disk
 * session state, classify liveness, and best-effort enrich with summaries.
 */
export type { ListOptions } from "./discovery.js";
export {
  listSessions,
  getSession,
  isPidAlive,
  enrichSummaries,
  removeStaleLocks,
  getProcessSnapshot,
} from "./discovery.js";
