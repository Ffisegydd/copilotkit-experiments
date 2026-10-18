import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, Vite proxies to the Python processes. In production FastAPI serves
// the built files itself, so these paths are same-origin there too.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    port: 5173,
    proxy: {
      "/agent": { target: "http://127.0.0.1:8123", rewrite: (p) => p.replace(/^\/agent/, "") || "/" },
      "/api": "http://127.0.0.1:8124",
    },
  },
});
