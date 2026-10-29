import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server";
import { REPO_TESTS_GATE_NOTE } from "../src/service";
import {
  GithubMissionError,
  detectProject,
  parseRepoUrl,
  shallowClone,
  validateRef,
} from "../src/github";
import { classifyEdit } from "../src/tools";
import { MockModel } from "../src/model";
import type { Runner } from "../src/runner";

const roots: string[] = [];
const apps: any[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "devpilot-gh-"));
  roots.push(d);
  return d;
};
const text = (v: any) => ({ role: "assistant", content: JSON.stringify(v), usage: { prompt_tokens: 5, completion_tokens: 2 } });
const call = (name: string, args: any, n: string) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: n, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return e instanceof GithubMissionError ? e.code : e.message;
  }
  return null;
};

describe("repo url and ref validation", () => {
  test("accepts github https links only", () => {
    expect(parseRepoUrl("https://github.com/pallets/click")).toEqual({ owner: "pallets", repo: "click" });
    expect(parseRepoUrl("https://github.com/a-b/c.d.git/")).toEqual({ owner: "a-b", repo: "c.d" });
    for (const bad of [
      "",
      "github.com/a/b",
      "http://github.com/a/b",
      "https://gitlab.com/a/b",
      "https://github.com.evil.com/a/b",
      "https://user:tok@github.com/a/b",
      "https://github.com/a",
      "https://github.com/a/b/tree/main",
      "https://github.com/a/b?x=1",
      "https://github.com/-a/b",
      "file:///etc/passwd",
      "ssh://git@github.com/a/b",
    ])
      expect(codeOf(() => parseRepoUrl(bad))).toBe("INVALID_REPO_URL");
  });
  test("refs", () => {
    expect(validateRef(undefined)).toBeNull();
    expect(validateRef("")).toBeNull();
    expect(validateRef("release/2.x")).toBe("release/2.x");
    for (const bad of ["--upload-pack=x", "a..b", "/x", "x/", "a b", "x.lock", 5])
      expect(codeOf(() => validateRef(bad))).toBe("INVALID_REF");
  });
});

describe("project detection and agent tests", () => {
  test("pytest projects are detected; others unsupported", () => {
    const d = tmp();
    writeFileSync(join(d, "main.js"), "1");
    expect(codeOf(() => detectProject(d))).toBe("UNSUPPORTED_PROJECT");
    mkdirSync(join(d, "tests"));
    writeFileSync(join(d, "tests", "test_x.py"), "def test_x(): pass\n");
    writeFileSync(join(d, "requirements.txt"), "");
    const info = detectProject(d);
    expect(info.kind).toBe("pytest");
    expect(info.test_files).toEqual(["tests/test_x.py"]);
    expect(info.requirements).toEqual(["requirements.txt"]);
  });
  test("new test_devpilot_*.py files are allowed; existing tests stay protected", () => {
    const base = tmp();
    mkdirSync(join(base, "tests"));
    writeFileSync(join(base, "tests", "test_x.py"), "");
    writeFileSync(join(base, "tests", "test_devpilot_old.py"), "");
    expect(classifyEdit(base, "tests/test_devpilot_new.py", base).kind).toBe("agent_test");
    expect(classifyEdit(base, "tests/test_x.py", base).kind).toBe("protected");
    expect(classifyEdit(base, "tests/test_devpilot_old.py", base).kind).toBe("protected");
    expect(classifyEdit(base, "tests/conftest.py", base).kind).toBe("protected");
    // Fixture missions (no base) keep the old behaviour.
    expect(classifyEdit(base, "tests/test_devpilot_new.py").kind).toBe("protected");
  });
});

function fakeRepo() {
  const src = tmp();
  writeFileSync(join(src, "calc.py"), "def add(a, b):\n    return a - b\n");
  mkdirSync(join(src, "tests"));
  writeFileSync(join(src, "tests", "test_calc.py"), "from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n");
  return src;
}
const runner: Runner = {
  isolation: "isolated",
  async check(snapshot) {
    const p = Bun.spawn(["python3", "-m", "pytest", "-q", "-p", "no:cacheprovider"], {
      cwd: snapshot,
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: snapshot },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { exitCode: code, output: out + err, duration: 1 };
  },
  async acceptance() {
    throw Error("hidden acceptance must not run for repo_tests missions");
  },
};

describe("POST /missions with repo_url", () => {
  function app(script: any, src = fakeRepo()) {
    const root = tmp();
    const clones: any[] = [];
    const a = startServer({
      root,
      registry: {},
      runner,
      model: new MockModel(script),
      port: 0,
      cloner: async (coords, ref, dest) => {
        clones.push({ coords, ref });
        cpSync(src, dest, { recursive: true });
        return { commit: "a".repeat(40), branch: "main" };
      },
    });
    apps.push(a);
    const base = `http://127.0.0.1:${a.server.port}`;
    const post = (body: any) =>
      fetch(`${base}/missions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { a, base, post, clones };
  }
  test("readable validation errors", async () => {
    const { post, clones } = app({});
    for (const [body, code] of [
      [{ repo_url: "https://gitlab.com/a/b", request: "x" }, "INVALID_REPO_URL"],
      [{ repo_url: "https://github.com/a/b", ref: "--x", request: "x" }, "INVALID_REF"],
      [{ repo_url: "https://github.com/a/b", request: "  " }, "MISSING_REQUEST"],
    ] as const) {
      const r = await post(body);
      expect(r.status).toBe(400);
      const j: any = await r.json();
      expect(j.error).toBe(code);
      expect(j.message.length).toBeGreaterThan(10);
    }
    expect(clones.length).toBe(0);
  });
  test("unsupported project", async () => {
    const src = tmp();
    writeFileSync(join(src, "index.js"), "1");
    const { post } = app({}, src);
    const r = await post({ repo_url: "https://github.com/a/b", request: "x" });
    expect(r.status).toBe(422);
    expect(((await r.json()) as any).error).toBe("UNSUPPORTED_PROJECT");
  });
  test("mission runs on repo tests, adds an agent test, refuses test tampering, offers a patch", async () => {
    const plan = [text({ criteria: [{ id: "request", description: "fix add" }, { id: "repo.tests", description: "tests" }], tasks: [{ id: "fix", title: "Fix add" }] })];
    const editor = [
      call("edit_file", { path: "tests/test_calc.py", old_text: "== 5", new_text: "== -1" }, "tamper"),
      call("edit_file", { path: "calc.py", old_text: "return a - b", new_text: "return a + b" }, "e1"),
      call("edit_file", { path: "tests/test_devpilot_add.py", old_text: "", new_text: "from calc import add\n\ndef test_neg():\n    assert add(-2, 5) == 3\n" }, "e2"),
      text({ done: true }),
    ];
    const { a, base, post } = app({
      shogun: plan,
      samurai: editor,
      shadow_review: [text({ findings: [] })],
      shadow_security: [text({ findings: [] })],
    });
    const r = await post({ repo_url: "https://github.com/acme/calc", request: "Fix add" });
    expect(r.status).toBe(202);
    const j: any = await r.json();
    expect(j.label).toBe("github:acme/calc@main");
    expect(j.acceptance_mode).toBe("repo_tests");
    const deadline = Date.now() + 20000;
    let m: any;
    while (Date.now() < deadline) {
      m = await (await fetch(`${base}/missions/${j.mission_id}`)).json();
      if (["AWAITING_APPROVAL", "ESCALATED", "FAILED", "COMPLETED"].includes(m.state)) break;
      await Bun.sleep(50);
    }
    const events = a.service.store.events(j.mission_id);
    expect(m.state).toBe("AWAITING_APPROVAL");
    expect(m.repo).toBe("github:acme/calc@main");
    expect(m.gate_note).toBe(REPO_TESTS_GATE_NOTE);
    expect(m.source.commit).toBe("a".repeat(40));
    const acc = events.find((e) => e.type === "test_result" && e.payload.acceptance_mode)!;
    expect(acc.payload.acceptance_mode).toBe("repo_tests");
    expect(acc.payload.gate_note).toBe("No hidden acceptance suite: evidence is the repo's own tests");
    expect(acc.verified).toBe(true);
    expect(events.find((e) => e.type === "approval_needed")!.payload.gate_note).toBe(REPO_TESTS_GATE_NOTE);
    expect(JSON.stringify(events)).toContain("PROTECTED_FILE");
    const patch = await fetch(`${base}/missions/${j.mission_id}/patch`);
    expect(patch.status).toBe(200);
    expect(patch.headers.get("content-disposition")).toContain("attachment");
    const body = await patch.text();
    expect(body).toContain("+    return a + b");
    expect(body).toContain("b/tests/test_devpilot_add.py");
    expect(body).not.toContain("== -1");
  });
});

// Real network clone; opt in with DEVPILOT_NET_TESTS=1.
test.skipIf(process.env.DEVPILOT_NET_TESTS !== "1")(
  "real shallow clone of a small public pytest repo",
  async () => {
    const dest = join(tmp(), "clone");
    const { commit, branch } = await shallowClone(
      { owner: "pytest-dev", repo: "pytest-repeat" },
      null,
      dest,
    );
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(branch).toBeTruthy();
    expect(existsSync(join(dest, ".git"))).toBe(false);
    expect(detectProject(dest).kind).toBe("pytest");
    const missing = join(tmp(), "nope");
    await expect(
      shallowClone({ owner: "pytest-dev", repo: "pytest-repeat" }, "no-such-branch-xyz", missing),
    ).rejects.toMatchObject({ code: "INVALID_REF" });
    await expect(
      shallowClone({ owner: "pytest-dev", repo: "pytest-repeat" }, null, join(tmp(), "big"), { maxBytes: 1000, timeoutMs: 60000, maxFiles: 5000 }),
    ).rejects.toMatchObject({ code: "CLONE_TOO_LARGE" });
  },
  90000,
);
