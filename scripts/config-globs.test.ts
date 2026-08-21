import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const GLOB_META = /[*?{}[\]]/;
const THRESHOLD_PATH_EXCEPTIONS = new Set([
  "services/host-daemon/src/cli.ts",
  "services/host-pane/src/lib/api.ts",
]);

function quotedStrings(block: string): string[] {
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function parseJsonc(text: string): unknown {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
}

describe("config file globs", () => {
  it("uses directory globs for coverage include and threshold paths", () => {
    const source = readFileSync(new URL("../vitest.config.ts", import.meta.url), "utf8");
    const coverageStart = source.indexOf("coverage: {");
    expect(coverageStart).toBeGreaterThan(-1);
    const coverage = source.slice(coverageStart);
    const includeBlock = coverage.match(/include:\s*\[([\s\S]*?)\],\s*exclude:/)?.[1];
    expect(includeBlock).toBeDefined();
    const include = quotedStrings(includeBlock ?? "");
    expect(include.length).toBeGreaterThan(0);
    for (const pattern of include) {
      expect(pattern, `coverage.include must be a glob: ${pattern}`).toMatch(GLOB_META);
    }

    const thresholdKeys = [...coverage.matchAll(/^\s+"([^"]+)":/gm)].map((match) => match[1]);
    expect(thresholdKeys.length).toBeGreaterThan(0);
    for (const key of thresholdKeys) {
      if (THRESHOLD_PATH_EXCEPTIONS.has(key)) continue;
      expect(key, `coverage.thresholds path must be a glob: ${key}`).toMatch(GLOB_META);
    }
  });

  it("uses a scripts/*.mts glob for knip root entries", () => {
    const knip = parseJsonc(readFileSync(new URL("../knip.jsonc", import.meta.url), "utf8")) as {
      workspaces?: { "."?: { entry?: string[] } };
    };
    const entry = knip.workspaces?.["."]?.entry ?? [];
    expect(entry).toContain("scripts/*.mts");
    expect(entry.some((pattern) => /^scripts\/[^*/]+\.mts$/.test(pattern))).toBe(false);
  });
});
