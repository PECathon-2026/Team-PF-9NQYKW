import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { confined, entries } from "./tree";
export const allowedCommands: Record<string, string[]> = {
  pytest: ["python3", "-m", "pytest", "-q"],
};
export function commandFor(id: string): string[] {
  if (!Object.hasOwn(allowedCommands, id)) throw Error("COMMAND_NOT_ALLOWED");
  return [...allowedCommands[id]!];
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
  if (name === "read_file")
    return {
      content: readFileSync(confined(root, args.path), "utf8").slice(0, 32000),
    };
  if (name === "list_dir")
    return { entries: readdirSync(confined(root, args.path)).slice(0, 500) };
  if (name === "search") {
    if (
      typeof args.query !== "string" ||
      !args.query ||
      args.query.length > 256
    )
      throw Error("INVALID_ARGUMENTS");
    const prefix = args.path || "";
    confined(root, prefix);
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
  const path = confined(root, args.path, true);
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
  return { path: args.path, changed: next !== old };
}
