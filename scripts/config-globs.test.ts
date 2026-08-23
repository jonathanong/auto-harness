import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const THRESHOLD_PATH_EXCEPTIONS = new Set([
  "services/host-daemon/src/cli.ts",
  "services/host-pane/src/lib/api.ts",
]);

function parseJsonc(text: string): unknown {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
}

describe("config file globs", () => {
  it("uses the shared coverage scope and recursive threshold paths", () => {
    const source = readFileSync(new URL("../vitest.config.ts", import.meta.url), "utf8");
    expect(source).toContain('from "./scripts/coverage-scope.mts"');
    expect(source).toContain("include: [...COVERAGE_INCLUDE]");
    expect(source).toContain("exclude: [...PATCH_COVERAGE_EXCLUDE]");
    expect(source).toContain("exclude: [...AGGREGATE_COVERAGE_EXCLUDE]");
    expect(source).toContain('provider: "custom"');

    const coverageStart = source.indexOf("coverage: {");
    expect(coverageStart).toBeGreaterThan(-1);
    const coverage = source.slice(coverageStart);
    const thresholdKeys = [...coverage.matchAll(/^\s+"([^"]+)":/gm)].map((match) => match[1]);
    expect(thresholdKeys.length).toBeGreaterThan(0);
    for (const key of thresholdKeys) {
      if (THRESHOLD_PATH_EXCEPTIONS.has(key)) continue;
      expect(key, `coverage.thresholds path must recurse with **: ${key}`).toContain("**");
    }

    const aggregateThresholds = coverage.match(
      /thresholds:[\s\S]*?\? undefined\s*:\s*\{([\s\S]*?)"services\/host-daemon/,
    )?.[1];
    expect(aggregateThresholds).toBeDefined();
    for (const metric of ["lines", "branches", "functions", "statements"]) {
      expect(aggregateThresholds).toMatch(new RegExp(`\\b${metric}: 99,`));
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
