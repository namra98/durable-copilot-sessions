import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { SessionManager, SessionFilter } from "../core/manager.js";
import { log } from "../core/logger.js";

const APP_VERSION = "0.1.0";

function asFilter(value: unknown): SessionFilter {
  return value === "all" ? "all" : value === "live" ? "live" : "open";
}

/** Build the Express app for a given SessionManager (kept separate for tests). */
export function createApp(manager: SessionManager): Express {
  const app = express();
  app.use(express.json());

  const api = express.Router();

  api.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, version: APP_VERSION, now: new Date().toISOString() });
  });

  // --- New feature routes (registered before :id routes to avoid collisions) ---
  api.get("/stats", (_req: Request, res: Response) => {
    res.json(manager.getStats());
  });

  api.get("/logs", (req: Request, res: Response) => {
    res.json({
      logs: manager.getLogs({
        lines: req.query.lines ? Number(req.query.lines) : undefined,
        level: typeof req.query.level === "string" ? req.query.level : undefined,
      }),
    });
  });

  api.put("/config", (req: Request, res: Response) => {
    res.json({ config: manager.saveConfig((req.body ?? {}) as Record<string, never>) });
  });

  api.get("/sessions/stale", (_req: Request, res: Response) => {
    res.json({ sessions: manager.listStale() });
  });

  api.post("/sessions/clean", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(manager.cleanStale({ remove: body.remove as boolean | undefined }));
  });

  api.get("/sessions/:id/transcript", (req: Request, res: Response) => {
    res.type("text/markdown").send(manager.getTranscript(req.params.id));
  });

  api.get("/workspaces/export", (req: Request, res: Response) => {
    const ids = typeof req.query.ids === "string" ? req.query.ids.split(",").filter(Boolean) : undefined;
    res.type("application/json").send(manager.exportWorkspacesJson(ids));
  });

  api.post("/workspaces/import", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.json !== "string") {
      res.status(400).json({ error: "json (string) is required" });
      return;
    }
    res.json({ workspaces: manager.importWorkspacesJson(body.json, { freshIds: body.freshIds as boolean | undefined }) });
  });

  api.get("/workspaces/:id/diff", (req: Request, res: Response) => {
    const diff = manager.getWorkspaceDiff(req.params.id);
    if (!diff) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    res.json(diff);
  });

  api.post("/workspaces/:id/promote", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name : "";
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const ws = manager.promoteSnapshot(req.params.id, name);
    if (!ws) {
      res.status(404).json({ error: "Snapshot not found" });
      return;
    }
    res.status(201).json({ workspace: ws });
  });

  api.get("/sessions", (req: Request, res: Response) => {
    res.json(manager.listSessionsResult(asFilter(req.query.filter)));
  });

  api.patch("/sessions/:id", (req: Request, res: Response) => {
    res.json({ session: manager.updateManaged(req.params.id, req.body ?? {}) });
  });

  api.post("/sessions/:id/resume", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(
      manager.resume({
        sessionId: req.params.id,
        window: body.window as "new" | "current" | undefined,
        color: body.color as string | undefined,
        title: body.title as string | undefined,
        cwd: body.cwd as string | undefined,
      }),
    );
  });

  api.post("/sessions/resume-batch", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(body.sessionIds) ? (body.sessionIds as string[]) : [];
    res.json(manager.resumeMany(ids, { window: body.window as "new" | "current" | undefined }));
  });

  api.post("/sessions/new", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.title !== "string" || typeof body.cwd !== "string") {
      res.status(400).json({ error: "title and cwd are required" });
      return;
    }
    res.json(
      manager.newSession({
        title: body.title,
        cwd: body.cwd,
        color: body.color as string | undefined,
        prompt: body.prompt as string | undefined,
        window: body.window as "new" | "current" | undefined,
      }),
    );
  });

  api.post("/sessions/:id/fork", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(
      manager.fork(req.params.id, {
        note: body.note as string | undefined,
        launch: body.launch as boolean | undefined,
        color: body.color as string | undefined,
        window: body.window as "new" | "current" | undefined,
      }),
    );
  });

  api.get("/sessions/:id", (req: Request, res: Response) => {
    const detail = manager.getSessionDetail(req.params.id);
    if (!detail.session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(detail);
  });

  // --- Session graph ---
  api.get("/graph", (req: Request, res: Response) => {
    res.json(manager.buildGraphModel(asFilter(req.query.filter)));
  });

  // --- Local memory / recall ---
  api.get("/memory/search", (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    res.json({
      hits: manager.searchMemory(q, {
        repository: typeof req.query.repository === "string" ? req.query.repository : undefined,
        kind: req.query.kind as never,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    });
  });

  api.get("/memory/related/:sessionId", (req: Request, res: Response) => {
    res.json({ memories: manager.relatedMemory(req.params.sessionId) });
  });

  api.get("/memory/recall", (req: Request, res: Response) => {
    res.json({
      pack: manager.recallMemory({
        repository: typeof req.query.repository === "string" ? req.query.repository : undefined,
        branch: typeof req.query.branch === "string" ? req.query.branch : undefined,
      }),
    });
  });

  api.get("/memory/session/:id", (req: Request, res: Response) => {
    res.json({ memories: manager.sessionMemory(req.params.id) });
  });

  api.post("/memory/reindex", (_req: Request, res: Response) => {
    res.json(manager.reindexMemory());
  });

  api.get("/workspaces", (_req: Request, res: Response) => {
    res.json({ workspaces: manager.listWorkspaces() });
  });

  api.get("/workspaces/:id", (req: Request, res: Response) => {
    const ws = manager.getWorkspace(req.params.id);
    if (!ws) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    res.json({ workspace: ws });
  });

  api.post("/workspaces", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.name !== "string" || body.name.trim() === "") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const ws = manager.createWorkspace({
      name: body.name,
      description: body.description as string | undefined,
      fromLive: body.fromLive as boolean | undefined,
      filter: asFilter(body.filter),
      windows: body.windows as never,
    });
    res.status(201).json({ workspace: ws });
  });

  api.delete("/workspaces/:id", (req: Request, res: Response) => {
    manager.deleteWorkspace(req.params.id);
    res.json({ ok: true });
  });

  api.post("/workspaces/:id/restore", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(
      manager.restoreWorkspace(req.params.id, {
        window: body.window as "new" | "current" | undefined,
      }),
    );
  });

  api.post("/snapshot", (_req: Request, res: Response) => {
    res.json({ workspace: manager.snapshot() });
  });

  api.get("/snapshots", (_req: Request, res: Response) => {
    res.json({ snapshots: manager.listSnapshots() });
  });

  api.get("/config", (_req: Request, res: Response) => {
    res.json({ config: manager.getConfig() });
  });

  app.use("/api", api);

  // Unknown /api routes get a JSON 404 (not the SPA fallback below).
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // Serve the built web UI when it exists (production). __dirname = dist/server.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = path.resolve(here, "../web");
  if (fs.existsSync(path.join(webDir, "index.html"))) {
    app.use(express.static(webDir));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(webDir, "index.html"));
    });
  }

  // Centralized error handler — manager methods are synchronous, so thrown
  // errors are forwarded here by Express.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error("api error", { scope: "server", error: message });
    res.status(500).json({ error: message });
  });

  return app;
}
