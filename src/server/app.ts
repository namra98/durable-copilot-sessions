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
  return value === "all" ? "all" : value === "live" ? "live" : "all";
}

/** Build the Express app for a given SessionManager (kept separate for tests). */
export function createApp(manager: SessionManager): Express {
  const app = express();
  app.use(express.json());

  const api = express.Router();

  api.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, version: APP_VERSION, now: new Date().toISOString() });
  });

  api.get("/sessions", (req: Request, res: Response) => {
    res.json({ sessions: manager.listSessions(asFilter(req.query.filter)) });
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
