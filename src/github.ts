/**
 * Real GitHub repository missions: URL/ref validation, a capped shallow clone
 * from https://github.com only, pytest project detection and a dependency
 * install step (the only step that has network access).
 *
 * No credentials are ever used: git runs with an empty HOME, no system/global
 * config and terminal prompts disabled, so only public repositories clone.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

export type GithubErrorCode =
  | "INVALID_REPO_URL"
  | "INVALID_REF"
  | "MISSING_REQUEST"
  | "CLONE_FAILED"
  | "CLONE_TOO_LARGE"
  | "CLONE_TIMEOUT"
  | "UNSUPPORTED_PROJECT"
  | "DEPENDENCY_INSTALL_FAILED";

export class GithubMissionError extends Error {
  constructor(
    public code: GithubErrorCode,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export type RepoCoordinates = { owner: string; repo: string };

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
/** Accept only https://github.com/<owner>/<repo>[.git][/]. */
export function parseRepoUrl(input: unknown): RepoCoordinates {
  const bad = (why: string) =>
    new GithubMissionError(
      "INVALID_REPO_URL",
      `Enter a public GitHub repository link like https://github.com/owner/repo (${why}).`,
    );
  if (typeof input !== "string" || !input.trim())
    throw bad("the repository link is empty");
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw bad("that is not a web address");
  }
  if (url.protocol !== "https:") throw bad("only https:// links are accepted");
  if (url.hostname.toLowerCase() !== "github.com" || url.port)
    throw bad("only github.com repositories are supported");
  if (url.username || url.password || url.search || url.hash)
    throw bad("remove any login details, ?query or #fragment");
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length !== 2) throw bad("the link must point at owner/repo");
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/, "");
  if (!NAME.test(owner) || !NAME.test(repo) || repo.endsWith("."))
    throw bad("the owner or repository name has unexpected characters");
  return { owner, repo };
}

/** Branch or tag names only (no option-looking or traversal refs). */
export function validateRef(ref: unknown): string | null {
  if (ref === undefined || ref === null || ref === "") return null;
  const bad = () =>
    new GithubMissionError(
      "INVALID_REF",
      "The branch or tag name is not valid. Use a name like main, v1.2.0 or release/2.x, or leave it empty for the default branch.",
    );
  if (typeof ref !== "string") throw bad();
  const r = ref.trim();
  if (
    !r ||
    r.length > 100 ||
    !/^[A-Za-z0-9._/-]+$/.test(r) ||
    r.startsWith("-") ||
    r.startsWith("/") ||
    r.endsWith("/") ||
    r.endsWith(".lock") ||
    r.includes("..") ||
    r.includes("//") ||
    r.endsWith(".")
  )
    throw bad();
  return r;
}

export type CloneLimits = { maxBytes: number; timeoutMs: number; maxFiles: number };
export function cloneLimits(): CloneLimits {
  const num = (name: string, fallback: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    maxBytes: num("DEVPILOT_CLONE_MAX_MB", 50) * 1024 * 1024,
    timeoutMs: num("DEVPILOT_CLONE_TIMEOUT_SECONDS", 60) * 1000,
    maxFiles: num("DEVPILOT_CLONE_MAX_FILES", 5000),
  };
}

function dirSize(path: string, limit: { files: number }): number {
  let total = 0;
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      limit.files++;
      if (st.isDirectory()) walk(full);
      else total += st.size;
    }
  };
  walk(path);
  return total;
}

/** Remove .git, symlinks and special files so the tree is snapshot-safe. */
function sanitize(dir: string) {
  rmSync(join(dir, ".git"), { recursive: true, force: true });
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full);
      else if (!st.isFile()) rmSync(full, { force: true });
    }
  };
  walk(dir);
}

const gitEnv = (home: string) => ({
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: home,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  GIT_LFS_SKIP_SMUDGE: "1",
});

/** Shallow, single-branch clone with size, file-count and time caps. */
export async function shallowClone(
  coords: RepoCoordinates,
  ref: string | null,
  dest: string,
  limits: CloneLimits = cloneLimits(),
): Promise<{ commit: string; branch: string | null }> {
  const label = `${coords.owner}/${coords.repo}`;
  const home = `${dest}.home`;
  mkdirSync(home, { recursive: true });
  const url = `https://github.com/${coords.owner}/${coords.repo}.git`;
  const argv = [
    "git",
    "-c", "core.symlinks=false",
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "credential.helper=",
    "clone", "--depth", "1", "--single-branch", "--no-tags",
    "--no-recurse-submodules", "--quiet",
    ...(ref ? ["--branch", ref] : []),
    "--", url, dest,
  ];
  const proc = Bun.spawn(argv, {
    env: gitEnv(home),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  let reason: "timeout" | "size" | null = null;
  const timer = setTimeout(() => {
    reason = "timeout";
    proc.kill();
  }, limits.timeoutMs);
  const poll = setInterval(() => {
    const counter = { files: 0 };
    if (
      dirSize(dest, counter) > limits.maxBytes ||
      counter.files > limits.maxFiles * 3
    ) {
      reason = reason || "size";
      proc.kill();
    }
  }, 250);
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  clearTimeout(timer);
  clearInterval(poll);
  const fail = (e: GithubMissionError) => {
    rmSync(dest, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    return e;
  };
  if (reason === "timeout")
    throw fail(
      new GithubMissionError(
        "CLONE_TIMEOUT",
        `Downloading ${label} took longer than ${Math.round(limits.timeoutMs / 1000)} seconds, so it was stopped. Try a smaller repository.`,
        504,
      ),
    );
  if (reason === "size")
    throw fail(tooLarge(label, limits));
  if (code !== 0) {
    if (ref && /Remote branch .* not found|couldn't find remote ref/i.test(stderr))
      throw fail(
        new GithubMissionError(
          "INVALID_REF",
          `The branch or tag "${ref}" does not exist in ${label}.`,
        ),
      );
    throw fail(
      new GithubMissionError(
        "CLONE_FAILED",
        `Could not download ${label}. Check that the repository exists and is public.`,
        502,
      ),
    );
  }
  const rev = Bun.spawnSync(["git", "-C", dest, "rev-parse", "HEAD"], {
    env: gitEnv(home),
  });
  const commit = rev.stdout.toString().trim();
  const branch = branchOf(dest);
  sanitize(dest);
  rmSync(home, { recursive: true, force: true });
  const counter = { files: 0 };
  if (dirSize(dest, counter) > limits.maxBytes || counter.files > limits.maxFiles)
    throw fail(tooLarge(label, limits));
  return { commit, branch };
}
function tooLarge(label: string, limits: CloneLimits) {
  return new GithubMissionError(
    "CLONE_TOO_LARGE",
    `${label} is larger than the ${Math.round(limits.maxBytes / 1048576)} MB / ${limits.maxFiles} file limit. Try a smaller repository.`,
    413,
  );
}

export type ProjectInfo = {
  kind: "pytest";
  /** Requirement files found in the repository root (installed in order). */
  requirements: string[];
  /** pyproject.toml present (its [project] dependencies are installed). */
  pyproject: boolean;
  /** src/ layout: candidate src/ is added to the import path. */
  src_layout: boolean;
  /** Paths of the repository's own test files (protected). */
  test_files: string[];
};

/** Detect a pytest project. pytest is checked first (and is the only kind today). */
export function detectProject(dir: string): ProjectInfo {
  const read = (p: string) => {
    try {
      return readFileSync(join(dir, p), "utf8");
    } catch {
      return "";
    }
  };
  const tests: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".") || name === "node_modules" || name === "venv")
        continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(join(d, name));
      if (st.isDirectory()) walk(join(d, name), rel);
      else if (/^test_.*\.py$|_test\.py$/.test(name)) tests.push(rel);
    }
  };
  walk(dir, "");
  const configured =
    existsSync(join(dir, "pytest.ini")) ||
    existsSync(join(dir, "conftest.py")) ||
    /\[tool\.pytest/.test(read("pyproject.toml")) ||
    /\[tool:pytest\]/.test(read("setup.cfg")) ||
    /\[pytest\]/.test(read("tox.ini"));
  if (!tests.length && !configured)
    throw new GithubMissionError(
      "UNSUPPORTED_PROJECT",
      "DevPilot currently supports Python projects tested with pytest, and no pytest tests (test_*.py or *_test.py) were found in this repository.",
      422,
    );
  if (!tests.length)
    throw new GithubMissionError(
      "UNSUPPORTED_PROJECT",
      "This repository is configured for pytest but has no test files (test_*.py or *_test.py), so there would be no evidence to check changes against.",
      422,
    );
  const requirements = readdirSync(dir)
    .filter((n) =>
      /^(requirements|requirements[-_](dev|test|tests))\.txt$/i.test(n),
    )
    .sort();
  return {
    kind: "pytest",
    requirements,
    pyproject: existsSync(join(dir, "pyproject.toml")),
    src_layout: existsSync(join(dir, "src")) && lstatSync(join(dir, "src")).isDirectory(),
    test_files: tests,
  };
}

/**
 * Python run inside the install sandbox: install requirement files plus
 * pyproject [project] dependencies (and test/dev extras) into the target, never
 * the project itself, so the candidate code is always what gets imported.
 */
export const INSTALL_SCRIPT = `
import subprocess, sys, os
src, target = sys.argv[1], sys.argv[2]
reqs = [a for a in sys.argv[3:]]
deps = []
pp = os.path.join(src, "pyproject.toml")
if os.path.exists(pp):
    import tomllib
    with open(pp, "rb") as f:
        data = tomllib.load(f)
    proj = data.get("project", {})
    deps += proj.get("dependencies", [])
    for extra in ("test", "tests", "testing", "dev"):
        deps += proj.get("optional-dependencies", {}).get(extra, [])
    for group in ("test", "tests", "dev"):
        deps += [d for d in data.get("dependency-groups", {}).get(group, []) if isinstance(d, str)]
deps = [d for d in deps if not d.lower().replace("_", "-").startswith(("pytest ", "pytest=", "pytest>", "pytest<", "pytest~", "pytest!")) and d.strip().lower() != "pytest"]
args = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-cache-dir", "--only-binary=:all:", "--target", target]
if not reqs and not deps:
    print("no dependencies declared"); sys.exit(0)
cmd = args + deps
for r in reqs:
    cmd += ["-r", os.path.join(src, r)]
sys.exit(subprocess.call(cmd))
`;

export function missionLabel(coords: RepoCoordinates, ref: string) {
  return `github:${coords.owner}/${coords.repo}@${ref}`;
}

/** Default-branch name of a fresh clone is unknown before cloning; read it. */
export function branchOf(dir: string): string | null {
  try {
    const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}
