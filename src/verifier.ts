import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { copyTree, entries } from "./tree";
import type { RunResult } from "./runner";

type Isolation = "isolated" | "unisolated";
type Config = {
  isolation: Isolation;
  engine: string | null;
  image: string;
  engineEnv: Record<string, string>;
  environment: Record<string, string>;
  site: string;
  networkPrefix: string[];
  execute: (
    argv: string[],
    cwd: string,
    env: Record<string, string>,
    deadline: number,
  ) => Promise<RunResult>;
  suiteDigest: (path: string) => string;
};
const toolsDir = resolve(import.meta.dir, "verification");

function readOnly(root: string) {
  const list = entries(root);
  for (const item of list.filter((item) => !item.dir))
    chmodSync(join(root, item.path), item.executable ? 0o555 : 0o444);
  for (const item of list.filter((item) => item.dir).reverse())
    chmodSync(join(root, item.path), 0o555);
  chmodSync(root, 0o555);
}
function makeWritable(root: string) {
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;
  chmodSync(root, 0o700);
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const item = lstatSync(path);
    if (item.isDirectory() && !item.isSymbolicLink()) makeWritable(path);
  }
}
function xmlResults(xml: string): Map<string, boolean> | null {
  if (xml.length > 4_000_000 || XMLValidator.validate(xml) !== true)
    return null;
  try {
    const doc = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      parseAttributeValue: false,
      processEntities: true,
    }).parse(xml);
    if (!doc.testsuites && !doc.testsuite) return null;
    const cases = new Map<string, boolean>();
    const walk = (node: any) => {
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "testcase") {
          for (const item of Array.isArray(value) ? value : [value]) {
            if (
              !item ||
              typeof item !== "object" ||
              typeof item["@_classname"] !== "string" ||
              typeof item["@_name"] !== "string"
            )
              throw Error("INVALID_REPORT");
            const id = `${item["@_classname"]}::${item["@_name"]}`;
            if (cases.has(id)) throw Error("INVALID_REPORT");
            cases.set(
              id,
              !("failure" in item || "error" in item || "skipped" in item),
            );
          }
        } else if (typeof value === "object") {
          for (const child of Array.isArray(value) ? value : [value])
            walk(child);
        }
      }
    };
    walk(doc);
    return cases;
  } catch {
    return null;
  }
}

export async function verifyCandidate(
  snapshot: string,
  suite: any,
  deadline: number,
  config: Config,
): Promise<{ passed: boolean; criteria: { id: string; passed: boolean }[] }> {
  if (!suite?.path || config.suiteDigest(suite.path) !== suite.digest)
    throw Error("SUITE_CHANGED");
  const temp = mkdtempSync(join(tmpdir(), "devpilot-verifier-"));
  const candidate = join(temp, "candidate"),
    privateSuite = join(temp, "private-suite"),
    proxies = join(temp, "proxies"),
    scratch = join(temp, "scratch"),
    results = join(temp, "results"),
    bridge = join(temp, "bridge");
  for (const path of [proxies, scratch, results, bridge]) mkdirSync(path);
  let worker: ReturnType<typeof Bun.spawn> | undefined;
  let server: ReturnType<typeof Bun.listen> | undefined;
  let active: any;
  const containerNames: string[] = [];
  const containerName = () => {
    const name = `devpilot-verifier-${randomUUID()}`;
    containerNames.push(name);
    return name;
  };
  try {
    copyTree(snapshot, candidate);
    copyTree(suite.path, privateSuite);
    if (config.suiteDigest(privateSuite) !== suite.digest)
      throw Error("SUITE_CHANGED");
    readOnly(candidate);
    readOnly(privateSuite);
    for (const item of entries(candidate)) {
      if (
        item.dir ||
        item.path.includes("/") ||
        !/^[A-Za-z_]\w*\.py$/.test(item.path)
      )
        continue;
      writeFileSync(
        join(proxies, item.path),
        "from devpilot_proxy import resolve as _resolve\ndef __getattr__(name): return _resolve(__name__, name)\n",
      );
    }
    const configFile = join(results, "pytest.ini");
    writeFileSync(configFile, "[pytest]\n");
    const inContainer = config.isolation === "isolated";
    const suitePath = inContainer ? "/private" : privateSuite;
    const proxyPath = inContainer ? "/proxies" : proxies;
    const scratchPath = inContainer ? "/scratch" : scratch;
    const resultsPath = inContainer ? "/results" : results;
    const helperPath = inContainer ? "/tools" : toolsDir;
    const rpcPath = inContainer ? "/bridge/rpc.sock" : join(bridge, "rpc.sock");
    const baseArgs = [
      "-I",
      `${helperPath}/bootstrap.py`,
      inContainer ? "" : config.site,
      helperPath,
      "-q",
      "-p",
      "no:cacheprovider",
      "-p",
      "devpilot_pytest",
      "-c",
      `${resultsPath}/pytest.ini`,
      "--confcutdir",
      suitePath,
      "--rootdir",
      suitePath,
      "--import-mode=importlib",
      "--basetemp",
      `${scratchPath}/pytest-base`,
    ];
    const harnessEnv = {
      ...config.environment,
      CANDIDATE_DIR: proxyPath,
      DEVPILOT_RPC: rpcPath,
      DEVPILOT_COLLECTION: `${resultsPath}/collection.json`,
    };
    const harnessCommand = (args: string[]) => {
      if (!inContainer)
        return [...config.networkPrefix, "python3", ...baseArgs, ...args];
      return [
        config.engine!,
        "run",
        "--rm",
        "--name",
        containerName(),
        "--pull=never",
        "--network=none",
        "--read-only",
        "--cap-drop=all",
        "--security-opt=no-new-privileges",
        "--pids-limit=64",
        "--memory=512m",
        "--cpus=1",
        "--tmpfs",
        "/tmp:rw,nosuid,size=64m",
        "--volume",
        `${privateSuite}:/private:ro`,
        "--volume",
        `${proxies}:/proxies:ro`,
        "--volume",
        `${toolsDir}:/tools:ro`,
        "--volume",
        `${scratch}:/scratch:rw`,
        "--volume",
        `${results}:/results:rw`,
        "--volume",
        `${bridge}:/bridge:rw`,
        "--workdir",
        "/tmp",
        "--env",
        `CANDIDATE_DIR=${proxyPath}`,
        "--env",
        `DEVPILOT_RPC=${rpcPath}`,
        "--env",
        `DEVPILOT_COLLECTION=${resultsPath}/collection.json`,
        "--env",
        "PYTHONDONTWRITEBYTECODE=1",
        "--env",
        "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1",
        config.image,
        "python3",
        ...baseArgs,
        ...args,
      ];
    };
    const collection = await config.execute(
      harnessCommand(["--collect-only", suitePath]),
      temp,
      inContainer ? config.engineEnv : harnessEnv,
      deadline,
    );
    let expected: string[] = [];
    try {
      expected = JSON.parse(
        readFileSync(join(results, "collection.json"), "utf8"),
      );
    } catch {
      /* Fail closed below. */
    }
    if (
      collection.exitCode !== 0 ||
      !Array.isArray(expected) ||
      !expected.length ||
      expected.some((x) => typeof x !== "string" || !x || x.length > 500) ||
      new Set(expected).size !== expected.length
    )
      return { passed: false, criteria: [] };
    expected.sort();
    rmSync(join(results, "collection.json"), { force: true });
    const workerCmd = !inContainer
      ? [
          ...config.networkPrefix,
          "python3",
          "-I",
          join(toolsDir, "worker.py"),
          candidate,
          config.site,
        ]
      : [
          config.engine!,
          "run",
          "--rm",
          "--name",
          containerName(),
          "--interactive",
          "--pull=never",
          "--network=none",
          "--read-only",
          "--cap-drop=all",
          "--security-opt=no-new-privileges",
          "--pids-limit=64",
          "--memory=512m",
          "--cpus=1",
          "--tmpfs",
          "/tmp:rw,nosuid,size=64m",
          "--volume",
          `${candidate}:/candidate:ro`,
          "--volume",
          `${scratch}:/scratch:rw`,
          "--volume",
          `${join(toolsDir, "worker.py")}:/worker.py:ro`,
          "--workdir",
          "/tmp",
          "--env",
          "PYTHONDONTWRITEBYTECODE=1",
          config.image,
          "python3",
          "-I",
          "/worker.py",
          "/candidate",
        ];
    worker = Bun.spawn(workerCmd, {
      cwd: temp,
      env: inContainer ? config.engineEnv : config.environment,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const child = worker as any;
    server = Bun.listen({
      unix: join(bridge, "rpc.sock"),
      socket: {
        open(socket) {
          if (active) socket.end();
          else active = socket;
        },
        data(socket, data) {
          try {
            child.stdin.write(data);
          } catch {
            socket.end();
          }
        },
        close(socket) {
          if (active === socket) active = undefined;
        },
        drain() {},
        error(socket) {
          socket.end();
        },
      },
    });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const pump = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (active && value) active.write(value);
        }
      } catch {
      } finally {
        if (active) active.end();
      }
    })();
    const run = await config.execute(
      harnessCommand(["--junitxml", `${resultsPath}/report.xml`, suitePath]),
      temp,
      inContainer ? config.engineEnv : harnessEnv,
      deadline,
    );
    let actualCollection: string[] = [];
    try {
      actualCollection = JSON.parse(
        readFileSync(join(results, "collection.json"), "utf8"),
      );
    } catch {}
    let reported: Map<string, boolean> | null = null;
    try {
      reported = xmlResults(readFileSync(join(results, "report.xml"), "utf8"));
    } catch {}
    const sameCollection =
      Array.isArray(actualCollection) &&
      actualCollection.length === expected.length &&
      new Set(actualCollection).size === expected.length &&
      actualCollection.every((id) => expected.includes(id));
    const complete =
      sameCollection &&
      reported !== null &&
      reported.size === expected.length &&
      expected.every((id) => reported!.has(id));
    const expectedExit =
      run.exitCode === 0 ||
      (run.exitCode === 1 &&
        reported !== null &&
        [...reported.values()].some((passed) => !passed));
    const criteria = expected.map((id) => ({
      id,
      passed: !!complete && expectedExit && !!reported!.get(id),
    }));
    child.kill();
    if (active) active.end();
    // A killed container client can briefly outlive its worker. Continue to
    // the forced container cleanup even if its output pipe remains open.
    await Promise.race([pump, Bun.sleep(500)]);
    if (config.suiteDigest(suite.path) !== suite.digest)
      throw Error("SUITE_CHANGED");
    return {
      passed: run.exitCode === 0 && complete && criteria.every((c) => c.passed),
      criteria,
    };
  } finally {
    if (active) active.end();
    server?.stop(true);
    if (worker) {
      try {
        worker.kill();
      } catch {}
    }
    if (config.isolation === "isolated" && containerNames.length) {
      Bun.spawnSync([config.engine!, "rm", "-f", ...containerNames], {
        env: config.engineEnv,
        stdout: "ignore",
        stderr: "ignore",
        timeout: 5000,
      });
    }
    makeWritable(candidate);
    makeWritable(privateSuite);
    rmSync(temp, { recursive: true, force: true });
  }
}
