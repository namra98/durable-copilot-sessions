import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// The web app lives in src/web and is served by the local API in production.
// In dev, Vite proxies /api to the Express server (default port 4517).
const API_PORT = process.env.DCS_API_PORT ?? "4517";

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
  server: {
    port: Number(process.env.DCS_WEB_PORT ?? 4516),
    strictPort: false,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          graph: ["@xyflow/react", "@dagrejs/dagre"],
        },
      },
    },
  },
});
