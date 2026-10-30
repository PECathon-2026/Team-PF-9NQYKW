// `bun run setup`: install deps, build the pinned Python+pytest sandbox image
// with Podman (or Docker), and write DEVPILOT_CONTAINER_IMAGE into .env.
// Safe to re-run. Never writes API keys.
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const sh = (cmd: string[], input?: string) =>
  Bun.spawnSync(cmd, { cwd: root, stdin: input ? new TextEncoder().encode(input) : "inherit", stdout: "pipe", stderr: "inherit" });
const step = (cmd: string[], cwd = root) => {
  console.log(`$ ${cmd.join(" ")}`);
  if (Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" }).exitCode !== 0) process.exit(1);
};
step(["bun", "install"]);
step(["bun", "install"], resolve(root, "web"));
const envPath = resolve(root, ".env");
if (!existsSync(envPath)) copyFileSync(resolve(root, ".env.example"), envPath);
const rt = ["podman", "docker"].find((r) => Bun.which(r));
if (!rt) {
  console.warn("\n! Neither podman nor docker found. Install one (see README), then re-run `bun run setup`.");
  console.warn("  Meanwhile the UI replay works with no backend: `cd web && bun run dev`, open http://localhost:5173/?replay=1");
  process.exit(0);
}
console.log(`$ ${rt} build -t devpilot-py:1 -`);
const b = sh([rt, "build", "-t", "devpilot-py:1", "-"], "FROM python:3.12-slim\nRUN pip install --no-cache-dir pytest\n");
if (b.exitCode !== 0) { console.error(`! ${rt} build failed. Is the ${rt} daemon/machine running?`); process.exit(1); }
const fmt = rt === "podman" ? "{{.Digest}}" : "{{.Id}}";
const digest = new TextDecoder().decode(sh([rt, "image", "inspect", "devpilot-py:1", "--format", fmt]).stdout).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(digest)) { console.error(`! could not read image digest (got "${digest}")`); process.exit(1); }
const line = `DEVPILOT_CONTAINER_IMAGE=devpilot-py:1@${digest}`;
let env = readFileSync(envPath, "utf8");
env = /^DEVPILOT_CONTAINER_IMAGE=.*$/m.test(env) ? env.replace(/^DEVPILOT_CONTAINER_IMAGE=.*$/m, line) : env + `\n${line}\n`;
writeFileSync(envPath, env);
console.log(`\n✓ Setup done. ${line} written to .env\n  Next: bun run demo  →  open http://127.0.0.1:8787`);
