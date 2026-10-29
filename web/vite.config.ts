import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Dev proxy to the Bun service on :8787 (production: served same-origin by that service).
// The service requires Origin host === Host; the proxy rewrites Host to the target, so drop the
// browser Origin on proxied requests (dev only — the production build is same-origin).
const T = "127.0.0.1:8787";
const strip = (proxy: any) => {
  proxy.on("proxyReq", (r: any) => r.removeHeader("origin"));
  proxy.on("proxyReqWs", (r: any) => r.removeHeader("origin"));
};
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: {
    "/missions": { target: `http://${T}`, changeOrigin: true, configure: strip },
    "/ws": { target: `ws://${T}`, ws: true, changeOrigin: true, configure: strip },
  } },
});
