import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Dev proxy to the Bun service on :8787 (production: served same-origin by that service).
// The service accepts the Vite origin via DEVPILOT_ALLOWED_ORIGINS (default includes :5173).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/missions": "http://127.0.0.1:8787", "/ws": { target: "ws://127.0.0.1:8787", ws: true } } },
});
