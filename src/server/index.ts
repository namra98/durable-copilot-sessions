import path from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import { SessionManager } from "../core/manager.js";
import { loadConfig } from "../core/config.js";
import { ensureStateDirs } from "../core/paths.js";
import { log } from "../core/logger.js";
import { createApp } from "./app.js";

export interface ServeOptions {
  port?: number;
  openBrowser?: boolean;
  manager?: SessionManager;
}

export interface RunningServer {
  port: number;
  url: string;
  reused: boolean;
  close: () => Promise<void>;
}

function isAddressInUse(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EADDRINUSE";
}

async function isDcsServer(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const res = await fetch(`${url}/api/health`, { signal: controller.signal });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { ok?: unknown; version?: unknown };
    return body.ok === true && typeof body.version === "string";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function maybeOpenBrowser(url: string, enabled: boolean): void {
  if (!enabled) {
    return;
  }
  void open(url).catch(() => {
    /* browser launch is best-effort */
  });
}

/** Start the local API + web server on 127.0.0.1. */
export function startServer(opts: ServeOptions = {}): Promise<RunningServer> {
  ensureStateDirs();
  const config = loadConfig();
  const port = opts.port ?? config.apiPort;
  const manager = opts.manager ?? new SessionManager({ config });
  const app = createApp(manager);

  return new Promise<RunningServer>((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${port}`;
      log.info("server listening", { scope: "server", url });
      maybeOpenBrowser(url, opts.openBrowser ?? false);
      resolve({
        port,
        url,
        reused: false,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
    server.on("error", (err: unknown) => {
      if (!isAddressInUse(err)) {
        reject(err);
        return;
      }

      const url = `http://127.0.0.1:${port}`;
      void isDcsServer(url).then((reusable) => {
        if (!reusable) {
          reject(err);
          return;
        }
        log.info("server already listening", { scope: "server", url });
        maybeOpenBrowser(url, opts.openBrowser ?? false);
        resolve({
          port,
          url,
          reused: true,
          close: async () => undefined,
        });
      }, reject);
    });
  });
}

// When executed directly (e.g. `node dist/server/index.js` or `npm start`),
// start the server without opening a browser.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  startServer({ openBrowser: false }).catch((err) => {
    log.error("failed to start server", {
      scope: "server",
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  });
}
