import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionManager } from "../core/manager.js";

type StartServer = typeof import("./index.js").startServer;

let startServer: StartServer;
let tmpStateDir: string;

function makeFakeManager(): SessionManager {
  return {} as unknown as SessionManager;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

beforeAll(async () => {
  tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-server-test-"));
  process.env.DCS_STATE_DIR = tmpStateDir;
  ({ startServer } = await import("./index.js"));
});

afterAll(() => {
  delete process.env.DCS_STATE_DIR;
  fs.rmSync(tmpStateDir, { recursive: true, force: true });
});

describe("startServer", () => {
  it("reuses an existing DCS server with the dashboard root URL", async () => {
    const existingServer = createServer((req, res) => {
      if (req.url === "/api/health") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, version: "0.1.0" }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(existingServer);

    try {
      const server = await startServer({
        manager: makeFakeManager(),
        openBrowser: false,
        port,
      });

      expect(server.reused).toBe(true);
      expect(server.url).toBe(`http://127.0.0.1:${port}`);
      expect(server.url).not.toContain("restore-prompt");
      await server.close();
    } finally {
      await close(existingServer);
    }
  });

  it("rejects when the port belongs to a non-DCS process", async () => {
    const existingServer = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(existingServer);

    try {
      await expect(
        startServer({
          manager: makeFakeManager(),
          openBrowser: false,
          port,
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await close(existingServer);
    }
  });
});
