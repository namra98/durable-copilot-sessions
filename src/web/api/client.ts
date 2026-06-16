/**
 * Typed fetch wrapper around the local Express API exposed under `/api`.
 *
 * Every helper throws an `Error` carrying the server-provided message on a
 * non-2xx response so callers can surface it directly in a toast.
 */
import type {
  AppConfig,
  DiscoveredSession,
  LaunchResult,
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
};

/** Liveness filter accepted by the sessions and workspace-capture endpoints. */
export type SessionFilter = "live" | "all";

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

/** `GET /api/sessions?filter=…` -> the session list. */
export async function listSessions(filter: SessionFilter): Promise<SessionView[]> {
  const data = await request<{ sessions: SessionView[] }>(
    `/sessions?filter=${encodeURIComponent(filter)}`,
  );
  return data.sessions;
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
