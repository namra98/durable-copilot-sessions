/**
 * Workspace EXPORT/IMPORT for durable-copilot-sessions.
 *
 * Serializes a set of {@link Workspace} layouts to a portable JSON envelope and
 * parses such envelopes back into validated, sanitized Workspace objects. Used
 * to move named layouts between machines or back them up outside the registry.
 */

import { randomUUID } from "node:crypto";
import type {
  TabSpec,
  WindowSpec,
  Workspace,
  WorkspaceSource,
} from "../types.js";

/** The portable envelope produced by {@link exportWorkspaces}. */
export interface WorkspaceExport {
  kind: "durable-copilot-sessions/workspaces";
  version: 1;
  exportedAt: string;
  workspaces: Workspace[];
}

const EXPORT_KIND = "durable-copilot-sessions/workspaces";
const EXPORT_VERSION = 1;
const VALID_SOURCES: ReadonlySet<WorkspaceSource> = new Set<WorkspaceSource>([
  "manual",
  "auto-snapshot",
  "imported",
]);

/** Serialize workspaces to a pretty-printed {@link WorkspaceExport} JSON string. */
export function exportWorkspaces(workspaces: Workspace[]): string {
  const envelope: WorkspaceExport = {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    workspaces: workspaces.map(sanitizeWorkspace),
  };
  return JSON.stringify(envelope, null, 2);
}

/**
 * Parse and validate a {@link WorkspaceExport} JSON string, returning the
 * sanitized workspaces. Throws a clear Error on malformed input. Unknown fields
 * are dropped and values are coerced to the expected shapes. Workspace ids are
 * preserved (the registry decides whether to regenerate them).
 */
export function parseWorkspaceExport(json: string): Workspace[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid workspace export: not valid JSON (${message}).`);
  }

  if (!isRecord(parsed)) {
    throw new Error("Invalid workspace export: expected a JSON object.");
  }
  if (parsed.kind !== EXPORT_KIND) {
    throw new Error(
      `Invalid workspace export: expected kind "${EXPORT_KIND}", got ${describe(parsed.kind)}.`,
    );
  }
  if (parsed.version !== EXPORT_VERSION) {
    throw new Error(
      `Invalid workspace export: unsupported version ${describe(parsed.version)} (expected ${EXPORT_VERSION}).`,
    );
  }
  if (!Array.isArray(parsed.workspaces)) {
    throw new Error("Invalid workspace export: `workspaces` must be an array.");
  }

  return parsed.workspaces.map((ws, i) => validateWorkspace(ws, i));
}

/**
 * Return copies of the given workspaces with freshly generated ids. Names, tabs,
 * windows, and other fields are preserved. Useful for import-as-copy callers.
 */
export function withFreshIds(workspaces: Workspace[]): Workspace[] {
  return workspaces.map((ws) => ({
    ...sanitizeWorkspace(ws),
    id: randomUUID(),
  }));
}

function validateWorkspace(value: unknown, index: number): Workspace {
  const where = `workspaces[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`Invalid workspace export: ${where} must be an object.`);
  }
  requireString(value.id, `${where}.id`);
  requireString(value.name, `${where}.name`);
  requireString(value.source, `${where}.source`);
  requireString(value.createdAt, `${where}.createdAt`);
  requireString(value.updatedAt, `${where}.updatedAt`);
  if (!Array.isArray(value.windows)) {
    throw new Error(`Invalid workspace export: ${where}.windows must be an array.`);
  }

  const windows = value.windows.map((win, w) =>
    validateWindow(win, `${where}.windows[${w}]`),
  );

  const source = VALID_SOURCES.has(value.source as WorkspaceSource)
    ? (value.source as WorkspaceSource)
    : "imported";

  const workspace: Workspace = {
    id: value.id,
    name: value.name,
    source,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    windows,
  };
  if (typeof value.description === "string") {
    workspace.description = value.description;
  }
  return workspace;
}

function validateWindow(value: unknown, where: string): WindowSpec {
  if (!isRecord(value)) {
    throw new Error(`Invalid workspace export: ${where} must be an object.`);
  }
  requireString(value.id, `${where}.id`);
  if (!Array.isArray(value.tabs)) {
    throw new Error(`Invalid workspace export: ${where}.tabs must be an array.`);
  }

  const tabs = value.tabs.map((tab, t) =>
    validateTab(tab, `${where}.tabs[${t}]`),
  );

  const window: WindowSpec = {
    id: value.id,
    tabs,
  };
  if (typeof value.label === "string") {
    window.label = value.label;
  }
  return window;
}

function validateTab(value: unknown, where: string): TabSpec {
  if (!isRecord(value)) {
    throw new Error(`Invalid workspace export: ${where} must be an object.`);
  }
  requireString(value.sessionId, `${where}.sessionId`);
  requireString(value.title, `${where}.title`);
  requireString(value.color, `${where}.color`);
  requireString(value.cwd, `${where}.cwd`);

  const tab: TabSpec = {
    sessionId: value.sessionId,
    title: value.title,
    color: value.color,
    cwd: value.cwd,
  };
  if (Array.isArray(value.copilotArgs)) {
    tab.copilotArgs = value.copilotArgs.filter(
      (a): a is string => typeof a === "string",
    );
  }
  return tab;
}

function sanitizeWorkspace(ws: Workspace): Workspace {
  return validateWorkspace(ws, 0);
}

function requireString(value: unknown, where: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Invalid workspace export: ${where} must be a non-empty string (got ${describe(value)}).`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
