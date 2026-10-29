import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const ignored = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".venv",
]);
export function entries(
  root: string,
): { path: string; dir: boolean; executable: boolean; bytes: Buffer }[] {
  const out: ReturnType<typeof entries> = [];
  function walk(dir: string, prefix: string) {
    for (const name of readdirSync(dir).sort()) {
      if (!prefix && ignored.has(name)) continue;
      if (name === ".env" || name.startsWith(".env."))
        throw new Error("SECRET_FILE");
      const path = prefix ? `${prefix}/${name}` : name;
      const full = join(dir, name),
        stat = lstatSync(full);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error("UNSAFE_TREE");
      const item = {
        path,
        dir: stat.isDirectory(),
        executable: !!(stat.mode & 0o111),
        bytes: stat.isFile() ? readFileSync(full) : Buffer.alloc(0),
      };
      out.push(item);
      if (item.dir) walk(full, path);
    }
  }
  walk(root, "");
  return out;
}
export function treeHash(root: string): string {
  const h = createHash("sha256");
  for (const e of entries(root))
    for (const part of [
      Buffer.from(e.path),
      Buffer.from(e.dir ? "d" : "f"),
      Buffer.from(e.executable ? "1" : "0"),
      e.bytes,
    ]) {
      const n = Buffer.alloc(8);
      n.writeBigUInt64BE(BigInt(part.length));
      h.update(n);
      h.update(part);
    }
  return h.digest("hex");
}
export function copyTree(src: string, dst: string) {
  const list = entries(src);
  mkdirSync(dst, { recursive: true });
  for (const e of list) {
    const p = join(dst, e.path);
    if (e.dir) mkdirSync(p, { recursive: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, e.bytes, { mode: e.executable ? 0o755 : 0o644 });
    }
  }
}
export function confined(
  root: string,
  path: string,
  allowMissing = false,
): string {
  if (
    typeof path !== "string" ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").includes("..") ||
    path.includes("\0")
  )
    throw new Error("INVALID_PATH");
  const base = realpathSync(root),
    full = resolve(base, path || ".");
  if (full !== base && !full.startsWith(base + sep))
    throw new Error("INVALID_PATH");
  let cur = base;
  for (const part of relative(base, full).split(sep).filter(Boolean)) {
    cur = join(cur, part);
    try {
      const stat = lstatSync(cur);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw new Error("INVALID_PATH");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      if (!allowMissing) throw new Error("NOT_FOUND");
    }
  }
  return full;
}
export function replaceTree(src: string, dst: string) {
  rmSync(dst, { recursive: true, force: true });
  copyTree(src, dst);
}
