/**
 * Typed fetch wrapper around the local Express API exposed under `/api`.
 *
 * Every helper throws an `Error` carrying the server-provided message on a
 * non-2xx response so callers can surface it directly in a toast.
 */
import type {
  AppConfig,
  DiscoveredSession,
  GraphModel,
  LaunchResult,
  Memory,
  MemoryKind,
  MemoryRecallPack,
  MemorySearchHit,
  TabColor,
  WindowSpec,
  WindowTarget,
  Workspace,
} from "../../core/types";

/**
 * A discovered session merged with any tool-managed metadata. Mirrors the
 * server's `SessionView`: the discovery fields plus optional managed overrides.
 */
export type SessionView = DiscoveredSession & {
  /** Managed display/tab-title override (else fall back to `name`). */
  title?: string;
  /** Managed tab color (hex or WT color name). */
  color?: string;
  /** Managed grouping key used to bucket tabs into windows. */
  group?: string;
  /** Whether the session is pinned (sorts first, always snapshotted). */
  pinned?: boolean;
  /** Whether the session is hidden from the default list. */
  hidden?: boolean;
  /** Whether tool-managed metadata exists for this session. */
  managed: boolean;
  /** "primary" = one open terminal's foreground session; "child" = co-located. */
  role?: "primary" | "child";
  /** Holder PID used to group this live session with its siblings. */
  groupPid?: number;
  /** For a primary: how many child (subagent/background) sessions it holds. */
  childCount?: number;
};

/** Liveness filter accepted by the sessions and workspace-capture endpoints. */
export type SessionFilter = "open" | "live" | "all";

/** The sessions list plus the honest count of distinct open terminals. */
export interface SessionListResult {
  sessions: SessionView[];
  openCount: number;
}

/** Health probe payload. */
export interface HealthResponse {
  ok: true;
  version: string;
  now: string;
}

/** Mutable fields accepted by `PATCH /api/sessions/:id`. */
export interface SessionPatch {
  title?: string;
  color?: string;
  group?: string;
  pinned?: boolean;
  hidden?: boolean;
}

/** Body for `POST /api/sessions/:id/resume`. */
export interface ResumeBody {
  window?: WindowTarget;
  color?: TabColor;
  title?: string;
  cwd?: string;
}

/** Body for `POST /api/sessions/resume-batch`. */
export interface ResumeBatchBody {
  sessionIds: string[];
  window?: WindowTarget;
}

/** Body for `POST /api/workspaces`. */
export interface CreateWorkspaceBody {
  name: string;
  description?: string;
  /** Capture the current discovered layout instead of supplying `windows`. */
  fromLive?: boolean;
  filter?: SessionFilter;
  windows?: WindowSpec[];
}

/** Body for `POST /api/workspaces/:id/restore`. */
export interface RestoreBody {
  window?: WindowTarget;
}

const API_BASE = "/api";

async function extractError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      const data = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (typeof data.error === "string") return data.error;
      if (typeof data.message === "string") return data.message;
    } catch {
      return text;
    }
  }
  return res.statusText || `Request failed (${res.status})`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    throw new Error(await extractError(res));
  }
  return (await res.json()) as T;
}

/** `GET /api/health` */
export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/health");
}

/** `GET /api/sessions?filter=…` -> the session list plus the open-terminal count. */
export async function listSessions(filter: SessionFilter): Promise<SessionListResult> {
  const data = await request<{ sessions: SessionView[]; openCount?: number }>(
    `/sessions?filter=${encodeURIComponent(filter)}`,
  );
  return { sessions: data.sessions, openCount: data.openCount ?? data.sessions.length };
}

/** Shape returned by `GET /api/sessions/:id`: the session plus its live children. */
export interface SessionDetail {
  session: SessionView;
  children: SessionView[];
}

/** `GET /api/sessions/:id` -> the full session plus its co-located children. */
export async function getSessionDetail(id: string): Promise<SessionDetail> {
  const data = await request<{ session: SessionView; children?: SessionView[] }>(
    `/sessions/${encodeURIComponent(id)}`,
  );
  return { session: data.session, children: data.children ?? [] };
}

/** `PATCH /api/sessions/:id` -> the updated session. */
export async function patchSession(id: string, patch: SessionPatch): Promise<SessionView> {
  const data = await request<{ session: SessionView }>(
    `/sessions/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return data.session;
}

/** `POST /api/sessions/:id/resume` -> the launch result. */
export function resumeSession(id: string, body: ResumeBody): Promise<LaunchResult> {
  return request<LaunchResult>(`/sessions/${encodeURIComponent(id)}/resume`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** `POST /api/sessions/resume-batch` -> the launch result for the whole group. */
export function resumeBatch(sessionIds: string[], window?: WindowTarget): Promise<LaunchResult> {
  const body: ResumeBatchBody = { sessionIds, window };
  return request<LaunchResult>("/sessions/resume-batch", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** `GET /api/workspaces` -> the saved workspaces. */
export async function listWorkspaces(): Promise<Workspace[]> {
  const data = await request<{ workspaces: Workspace[] }>("/workspaces");
  return data.workspaces;
}

/** `POST /api/workspaces` -> the created workspace. */
export async function createWorkspace(body: CreateWorkspaceBody): Promise<Workspace> {
  const data = await request<{ workspace: Workspace }>("/workspaces", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.workspace;
}

/** `DELETE /api/workspaces/:id` */
export async function deleteWorkspace(id: string): Promise<void> {
  await request<{ ok: true }>(`/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** `POST /api/workspaces/:id/restore` -> the launch result. */
export function restoreWorkspace(id: string, body: RestoreBody): Promise<LaunchResult> {
  return request<LaunchResult>(`/workspaces/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** `POST /api/snapshot` -> the captured workspace. */
export async function snapshot(): Promise<Workspace> {
  const data = await request<{ workspace: Workspace }>("/snapshot", { method: "POST" });
  return data.workspace;
}

/** `GET /api/config` -> the persisted app configuration. */
export async function getConfig(): Promise<AppConfig> {
  const data = await request<{ config: AppConfig }>("/config");
  return data.config;
}

/* ------------------------------------------------------------------ *
 * Session graph (canvas)
 * ------------------------------------------------------------------ */

/** Body for `POST /api/sessions/:id/fork`. */
export interface ForkBody {
  /** Free-text lineage note recorded on the new branched session. */
  note?: string;
  /** When true, also open a Windows Terminal tab for the new fork. */
  launch?: boolean;
  /** Preferred tab color for the fork. */
  color?: TabColor;
  /** Which window to target when launching. */
  window?: WindowTarget;
}

/** Result of `POST /api/sessions/:id/fork`. */
export interface ForkResult {
  session: SessionView;
  launch?: LaunchResult;
}

/** Body for `POST /api/sessions/new`. */
export interface NewSessionBody {
  title: string;
  cwd: string;
  color?: TabColor;
  prompt?: string;
  window?: WindowTarget;
}

/** `GET /api/graph?filter=…` -> the session graph plus the open-terminal count. */
export function getGraph(filter: SessionFilter): Promise<GraphModel> {
  return request<GraphModel>(`/graph?filter=${encodeURIComponent(filter)}`);
}

/** `POST /api/sessions/:id/fork` -> the new branched session (+ optional launch). */
export function forkSession(id: string, body: ForkBody = {}): Promise<ForkResult> {
  return request<ForkResult>(`/sessions/${encodeURIComponent(id)}/fork`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** `POST /api/sessions/new` -> the launch result for the freshly created session. */
export function newSession(body: NewSessionBody): Promise<LaunchResult> {
  return request<LaunchResult>("/sessions/new", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ *
 * Local memory / recall
 * ------------------------------------------------------------------ */

/** Query parameters accepted by `GET /api/memory/search`. */
export interface MemorySearchParams {
  q: string;
  repository?: string;
  kind?: MemoryKind;
  limit?: number;
}

/** `GET /api/memory/search?q=…` -> ranked memory hits. */
export async function searchMemory(params: MemorySearchParams): Promise<MemorySearchHit[]> {
  const qs = new URLSearchParams();
  qs.set("q", params.q);
  if (params.repository) qs.set("repository", params.repository);
  if (params.kind) qs.set("kind", params.kind);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  const data = await request<{ hits: MemorySearchHit[] }>(`/memory/search?${qs.toString()}`);
  return data.hits;
}

/** `GET /api/memory/related/:sessionId` -> memories related to a session. */
export async function relatedMemory(sessionId: string): Promise<Memory[]> {
  const data = await request<{ memories: Memory[] }>(
    `/memory/related/${encodeURIComponent(sessionId)}`,
  );
  return data.memories;
}

/** `GET /api/memory/recall?repository=&branch=` -> a recall pack for a repo. */
export async function recallMemory(repository: string, branch?: string): Promise<MemoryRecallPack> {
  const qs = new URLSearchParams();
  qs.set("repository", repository);
  if (branch) qs.set("branch", branch);
  const data = await request<{ pack: MemoryRecallPack }>(`/memory/recall?${qs.toString()}`);
  return data.pack;
}

/** `GET /api/memory/session/:id` -> memories extracted from a single session. */
export async function sessionMemory(id: string): Promise<Memory[]> {
  const data = await request<{ memories: Memory[] }>(`/memory/session/${encodeURIComponent(id)}`);
  return data.memories;
}

/** `POST /api/memory/reindex` -> the number of memories (re)indexed. */
export async function reindexMemory(): Promise<number> {
  const data = await request<{ count: number }>("/memory/reindex", { method: "POST" });
  return data.count;
}
