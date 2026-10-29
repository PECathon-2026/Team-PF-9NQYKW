import { createTwoFilesPatch } from "diff";
import { entries } from "./tree";

/** Render the cumulative change from the immutable mission base to a candidate. */
export function renderDiff(base: string, candidate: string): string {
  const before = new Map(
    entries(base)
      .filter((e) => !e.dir)
      .map((e) => [e.path, e]),
  );
  const after = new Map(
    entries(candidate)
      .filter((e) => !e.dir)
      .map((e) => [e.path, e]),
  );
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const output: string[] = [];
  for (const path of paths) {
    const oldFile = before.get(path),
      newFile = after.get(path);
    if (
      oldFile &&
      newFile &&
      oldFile.bytes.equals(newFile.bytes) &&
      oldFile.executable === newFile.executable
    )
      continue;
    const oldName = oldFile ? `a/${path}` : "/dev/null";
    const newName = newFile ? `b/${path}` : "/dev/null";
    if (oldFile?.bytes.includes(0) || newFile?.bytes.includes(0)) {
      output.push(`Binary files ${oldName} and ${newName} differ\n`);
      continue;
    }
    if (oldFile && newFile && oldFile.executable !== newFile.executable) {
      output.push(
        `old mode ${oldFile.executable ? "100755" : "100644"}\nnew mode ${newFile.executable ? "100755" : "100644"}\n`,
      );
    }
    output.push(
      createTwoFilesPatch(
        oldName,
        newName,
        oldFile?.bytes.toString("utf8") || "",
        newFile?.bytes.toString("utf8") || "",
        "",
        "",
      ),
    );
  }
  return output.join("");
}
