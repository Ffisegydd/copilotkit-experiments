import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

// The reviews REST API and the MCP server live in the Python api process
// (agent/api.py). Next only proxies to them, so the browser and MCP clients
// use this one port. Rewrites are fixed at build time; in the container the
// api is on loopback.
const apiUrl = process.env.API_URL || "http://127.0.0.1:8124";

const nextConfig: NextConfig = {
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  output: "standalone",
  serverExternalPackages: ["@copilotkit/runtime"],
  async rewrites() {
    return [
      { source: "/api/reviews", destination: `${apiUrl}/api/reviews` },
      { source: "/api/reviews/:path*", destination: `${apiUrl}/api/reviews/:path*` },
      { source: "/mcp", destination: `${apiUrl}/mcp` },
    ];
  },
};

export default nextConfig;
