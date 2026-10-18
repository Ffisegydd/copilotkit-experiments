import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, Vite serves the app and proxies everything else to the Python api
// process (agent/api.py), which passes /agent/* on to the agents. In production
// the api serves the built files itself, so these paths are same-origin there too.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    proxy: Object.fromEntries(["/api", "/agent", "/mcp"].map((p) => [p, "http://127.0.0.1:8124"])),
  },
});
