// `bun run demo`: build web/ (sources untouched; output goes to runtime/web-dist)
// and serve it same-origin from the Bun backend. Defaults to the mock model.
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const web = resolve(root, "web");
const out = resolve(root, "runtime/web-dist");
const run = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw Error(`${cmd.join(" ")} failed (${r.exitCode})`);
};
run(["bun", "install", "--frozen-lockfile"], web);
run(["bunx", "tsc", "--noEmit"], web);
run(["bunx", "vite", "build", "--outDir", out, "--emptyOutDir"], web);
const env = {
  ...process.env,
  DEVPILOT_WEB_DIR: out,
  DEVPILOT_MODEL: process.env.DEVPILOT_MODEL || "mock",
  PORT: process.env.PORT || "8787",
};
console.log(`demo: serving web + API on http://127.0.0.1:${env.PORT} (model=${env.DEVPILOT_MODEL})`);
const server = Bun.spawn(["bun", "src/server.ts"], { cwd: root, env, stdout: "inherit", stderr: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => server.kill());
process.exit(await server.exited);
