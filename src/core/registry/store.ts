import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  ManagedSession,
  Workspace,
  WindowSpec,
  WorkspaceSource,
} from "../types.js";
import {
  managedSessionsDir as defaultManagedDir,
  workspacesDir as defaultWorkspacesDir,
  snapshotsDir as defaultSnapshotsDir,
} from "../paths.js";

/**
 * Optional directory overrides. Tests inject hermetic temp directories; the
 * server uses the defaults derived from {@link paths}.
 */
export interface RegistryDirs {
  managedDir?: string;
  workspacesDir?: string;
  snapshotsDir?: string;
}

/**
 * Durable, file-backed store for tool-owned state. Each record is a single
 * JSON file written atomically. All reads tolerate a missing directory and
 * silently skip corrupt/unparseable files so one bad file never breaks a list.
 */
export interface Registry {
  /** Managed session metadata (filename `<sessionId>.json`). */
  getManaged(sessionId: string): ManagedSession | undefined;
  listManaged(): ManagedSession[];
  /** Merge `patch` over any existing record; always stamps `updatedAt`. */
  upsertManaged(
    patch: Partial<ManagedSession> & { sessionId: string },
  ): ManagedSession;
  deleteManaged(sessionId: string): void;

  /** Workspaces (filename `<id>.json`). */
  getWorkspace(id: string): Workspace | undefined;
  /** Sorted by `updatedAt` descending (newest first). */
  listWorkspaces(): Workspace[];
  findWorkspaceByName(name: string): Workspace | undefined;
  /** Generates `id` (UUID) and `createdAt`/`updatedAt`, then persists. */
  createWorkspace(input: {
    name: string;
    description?: string;
    source: WorkspaceSource;
    windows: WindowSpec[];
  }): Workspace;
  /** Upsert by `id`, bumping `updatedAt`. */
  saveWorkspace(ws: Workspace): Workspace;
  deleteWorkspace(id: string): void;

  /** Rolling auto-snapshots (filename `<timestamp>-<id>.json`). */
  addSnapshot(ws: Workspace, retain: number): Workspace;
  listSnapshots(): Workspace[];
  latestSnapshot(): Workspace | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Whether `id` is safe to use as a filename. Guards against path traversal from
 * API-supplied ids (e.g. `..%2F..%2Fconfig` decoded by Express). UUIDs and the
 * names this tool generates all satisfy this.
 */
function isSafeId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
}

/** Throw on an unsafe id used for a write path. */
function assertSafeId(id: string): void {
  if (!isSafeId(id)) {
    throw new Error(`Invalid id: ${JSON.stringify(id)}`);
  }
}

/** Read and parse a JSON file; returns undefined for missing/corrupt files. */
function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Atomically write JSON: write to a unique temp sibling, then rename over target. */
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Absolute paths of `*.json` files in `dir`; returns [] if `dir` is missing. */
function listJsonFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function createRegistry(dirs: RegistryDirs = {}): Registry {
  const managedDir = dirs.managedDir ?? defaultManagedDir;
  const workspacesDir = dirs.workspacesDir ?? defaultWorkspacesDir;
  const snapshotsDir = dirs.snapshotsDir ?? defaultSnapshotsDir;

  // Tests inject temp dirs, so ensure every used dir exists up front rather
  // than relying solely on ensureStateDirs().
  for (const dir of [managedDir, workspacesDir, snapshotsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const managedFile = (sessionId: string): string => {
    assertSafeId(sessionId);
    return path.join(managedDir, `${sessionId}.json`);
  };
  const workspaceFile = (id: string): string => {
    assertSafeId(id);
    return path.join(workspacesDir, `${id}.json`);
  };

  function getManaged(sessionId: string): ManagedSession | undefined {
    if (!isSafeId(sessionId)) return undefined;
    return readJson<ManagedSession>(managedFile(sessionId));
  }

  function listManaged(): ManagedSession[] {
    const out: ManagedSession[] = [];
    for (const file of listJsonFiles(managedDir)) {
      const rec = readJson<ManagedSession>(file);
      if (rec && typeof rec.sessionId === "string") {
        out.push(rec);
      }
    }
    return out;
  }

  function upsertManaged(
    patch: Partial<ManagedSession> & { sessionId: string },
  ): ManagedSession {
    const existing = getManaged(patch.sessionId);
    const merged: ManagedSession = {
      ...existing,
      ...patch,
      sessionId: patch.sessionId,
      updatedAt: nowIso(),
    };
    writeJsonAtomic(managedFile(patch.sessionId), merged);
    return merged;
  }

  function deleteManaged(sessionId: string): void {
    if (!isSafeId(sessionId)) return;
    fs.rmSync(managedFile(sessionId), { force: true });
  }

  function getWorkspace(id: string): Workspace | undefined {
    if (!isSafeId(id)) return undefined;
    return readJson<Workspace>(workspaceFile(id));
  }

  function listWorkspaces(): Workspace[] {
    const out: Workspace[] = [];
    for (const file of listJsonFiles(workspacesDir)) {
      const rec = readJson<Workspace>(file);
      if (rec && typeof rec.id === "string") {
        out.push(rec);
      }
    }
    out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return out;
  }

  function findWorkspaceByName(name: string): Workspace | undefined {
    return listWorkspaces().find((ws) => ws.name === name);
  }

  function createWorkspace(input: {
    name: string;
    description?: string;
    source: WorkspaceSource;
    windows: WindowSpec[];
  }): Workspace {
    const ts = nowIso();
    const ws: Workspace = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      source: input.source,
      createdAt: ts,
      updatedAt: ts,
      windows: input.windows,
    };
    writeJsonAtomic(workspaceFile(ws.id), ws);
    return ws;
  }

  function saveWorkspace(ws: Workspace): Workspace {
    const saved: Workspace = { ...ws, updatedAt: nowIso() };
    writeJsonAtomic(workspaceFile(saved.id), saved);
    return saved;
  }

  function deleteWorkspace(id: string): void {
    if (!isSafeId(id)) return;
    fs.rmSync(workspaceFile(id), { force: true });
  }

  /** Encode a timestamp so snapshot filenames sort chronologically. */
  function snapshotStamp(iso: string): string {
    return iso.replace(/[:.]/g, "-");
  }

  /** Snapshot files newest-first by filename (which encodes the timestamp). */
  function snapshotFilesNewestFirst(): string[] {
    return listJsonFiles(snapshotsDir).sort((a, b) =>
      path.basename(b).localeCompare(path.basename(a)),
    );
  }

  function pruneSnapshots(retain: number): void {
    const keep = Number.isFinite(retain) ? Math.max(0, Math.floor(retain)) : 50;
    for (const file of snapshotFilesNewestFirst().slice(keep)) {
      fs.rmSync(file, { force: true });
    }
  }

  function addSnapshot(ws: Workspace, retain: number): Workspace {
    const file = path.join(
      snapshotsDir,
      `${snapshotStamp(ws.createdAt)}-${ws.id}.json`,
    );
    writeJsonAtomic(file, ws);
    pruneSnapshots(retain);
    return ws;
  }

  function listSnapshots(): Workspace[] {
    const out: Workspace[] = [];
    for (const file of snapshotFilesNewestFirst()) {
      const rec = readJson<Workspace>(file);
      if (rec && typeof rec.id === "string") {
        out.push(rec);
      }
    }
    return out;
  }

  function latestSnapshot(): Workspace | undefined {
    for (const file of snapshotFilesNewestFirst()) {
      const rec = readJson<Workspace>(file);
      if (rec && typeof rec.id === "string") {
        return rec;
      }
    }
    return undefined;
  }

  return {
    getManaged,
    listManaged,
    upsertManaged,
    deleteManaged,
    getWorkspace,
    listWorkspaces,
    findWorkspaceByName,
    createWorkspace,
    saveWorkspace,
    deleteWorkspace,
    addSnapshot,
    listSnapshots,
    latestSnapshot,
  };
}
