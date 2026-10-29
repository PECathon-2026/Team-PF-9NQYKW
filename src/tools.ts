import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { confined, entries, isSecretName, normalizedPath } from "./tree";
export const allowedCommands: Record<string, string[]> = {
  pytest: ["python3", "-m", "pytest", "-q"],
};
export function commandFor(id: string): string[] {
  if (!Object.hasOwn(allowedCommands, id)) throw Error("COMMAND_NOT_ALLOWED");
  return [...allowedCommands[id]!];
}
/** Classify edit targets only after repository path confinement. */
export function classifyEdit(
  root: string,
  path: string,
  /** GitHub missions: the mission base; new test_devpilot_*.py files are allowed. */
  agentTestBase?: string,
): {
  path: string;
  kind: "protected" | "documentation" | "source" | "agent_test";
} {
  const normalized = normalizedPath(root, path, true);
  if (!normalized) throw Error("INVALID_PATH");
  const parts = normalized.toLowerCase().split("/");
  const name = parts.at(-1)!;
  // Agent-authored tests live only in files that did not exist in the cloned
  // repository, so existing tests keep the same tamper protection.
  if (
    agentTestBase &&
    /^test_devpilot_[a-z0-9_]{1,60}\.py$/.test(normalized.split("/").at(-1)!) &&
    !parts.some(isSecretName) &&
    !parts.some((part) => part.startsWith(".")) &&
    !existsSync(join(agentTestBase, normalized))
  )
    return { path: normalized, kind: "agent_test" };
  const testDirs = new Set(["tests", "test", "__tests__", "testing"]);
  const protectedNames = new Set([
    "conftest.py",
    "pytest.ini",
    ".pytest.ini",
    "pytest.py",
    "_pytest.py",
    "sitecustomize.py",
    "usercustomize.py",
    "pyproject.toml",
    "setup.cfg",
    "setup.py",
    "tox.ini",
    ".coveragerc",
    ".pre-commit-config.yaml",
    "package.json",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
  ]);
  if (
    parts.some((part) => testDirs.has(part)) ||
    parts.some((part) => part === "pytest" || part === "_pytest") ||
    (parts.includes(".github") && parts.includes("workflows")) ||
    protectedNames.has(name) ||
    parts.some(isSecretName) ||
    name.endsWith(".pth") ||
    /^test_.*\.py$/.test(name) ||
    /_test\.py$/.test(name) ||
    /^(?:jest|vitest|playwright|cypress)\.config\./.test(name)
  )
    return { path: normalized, kind: "protected" };
  if (
    parts.some((part) => part === "docs" || part === "documentation") ||
    /^readme(?:\.|$)/i.test(name)
  )
    return { path: normalized, kind: "documentation" };
  return { path: normalized, kind: "source" };
}
export function readTool(root: string, name: string, args: any): any {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw Error("INVALID_ARGUMENTS");
  const keys: Record<string, string[]> = {
    read_file: ["path"],
    list_dir: ["path"],
    search: ["path", "query"],
  };
  if (!keys[name] || Object.keys(args).some((k) => !keys[name]!.includes(k)))
    throw Error("INVALID_ARGUMENTS");
  if (
    typeof args.path === "string" &&
    args.path.split("/").some(isSecretName)
  )
    throw Error("NOT_FOUND");
  if (name === "read_file")
    return {
      content: readFileSync(confined(root, args.path), "utf8").slice(0, 32000),
    };
  if (name === "list_dir")
    return {
      entries: readdirSync(confined(root, args.path))
        .filter((entry) => !isSecretName(entry))
        .slice(0, 500),
    };
  if (name === "search") {
    if (
      typeof args.query !== "string" ||
      !args.query ||
      args.query.length > 256
    )
      throw Error("INVALID_ARGUMENTS");
    const prefix = normalizedPath(root, args.path ?? "");
    return {
      matches: entries(root)
        .filter(
          (e) =>
            !e.dir &&
            (e.path === prefix ||
              e.path.startsWith(prefix ? prefix + "/" : "")),
        )
        .flatMap((e) =>
          e.bytes
            .toString("utf8")
            .split("\n")
            .map((line, i) => ({
              path: e.path,
              line: i + 1,
              text: line.slice(0, 500),
            }))
            .filter((x) => x.text.includes(args.query)),
        )
        .slice(0, 100),
    };
  }
  throw Error("TOOL_NOT_ALLOWED");
}
export function editTool(root: string, args: any) {
  if (
    !args ||
    typeof args.path !== "string" ||
    typeof args.old_text !== "string" ||
    typeof args.new_text !== "string" ||
    Object.keys(args).some(
      (k) => !["path", "old_text", "new_text"].includes(k),
    ) ||
    args.new_text.length > 262144
  )
    throw Error("INVALID_ARGUMENTS");
  const relativePath = normalizedPath(root, args.path, true);
  if (!relativePath) throw Error("INVALID_PATH");
  const path = confined(root, relativePath, true);
  let old = "";
  try {
    old = readFileSync(path, "utf8");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  if (
    args.old_text &&
    (old.indexOf(args.old_text) < 0 ||
      old.indexOf(args.old_text) !== old.lastIndexOf(args.old_text))
  )
    throw Error("PATCH_CONTEXT");
  if (!args.old_text && old) throw Error("PATCH_CONTEXT");
  const next = args.old_text
    ? old.replace(args.old_text, args.new_text)
    : args.new_text;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return { path: relativePath, changed: next !== old };
}
