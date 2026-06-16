import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node environment for server/core/cli tests; the web fetch-client test
    // mocks global fetch and needs no DOM.
    environment: "node",
    // Forks pool avoids worker-isolation issues with file-system + child_process.
    pool: "forks",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
