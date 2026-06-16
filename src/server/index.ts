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
  close: () => Promise<void>;
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
      if (opts.openBrowser ?? false) {
        void open(url).catch(() => {
          /* browser launch is best-effort */
        });
      }
      resolve({
        port,
        url,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
    server.on("error", reject);
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
