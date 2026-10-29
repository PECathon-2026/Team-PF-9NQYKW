import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Load the trusted fixture manifest outside any candidate snapshot. */
export function loadRegistry(
  path: string,
  fixtureRoot: string,
): Record<string, any> {
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!config.fixture_registry) return config;
  const manifestPath = resolve(fixtureRoot, config.fixture_registry);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const registry: Record<string, any> = {};
  for (const [name, raw] of Object.entries(
    manifest.scenarios as Record<string, any>,
  )) {
    const scenario: any = raw;
    const suite = scenario.private_suite;
    registry[name] = {
      path: resolve(fixtureRoot, scenario.repo_path),
      search_disabled: !!scenario.search_tool_disabled,
      requests: {
        [scenario.request]: {
          suite: suite ? resolve(fixtureRoot, suite.path) : null,
          suite_id: suite ? `${name}.acceptance` : null,
          suite_sha256: scenario.private_suite_digest,
          check: scenario.public_check,
          acceptance: suite ? { argv: suite.argv } : null,
          criteria: [
            { id: `${name}.acceptance`, description: scenario.request },
          ],
        },
      },
    };
  }
  return registry;
}
