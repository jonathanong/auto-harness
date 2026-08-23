import { readFileSync } from "node:fs";
import { loadCoverageConfig } from "coverage-check";
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
    const config = loadCoverageConfig(".coverage-rules.yml");
    const { scope } = config;
    expect(scope).toBeDefined();
    expect(scope?.include).toEqual(["modules/*/src/**/*.{ts,tsx}", "services/*/src/**/*.{ts,tsx}"]);
    expect(config.rules).toEqual([
      { paths: "modules/**", patch_coverage_min: 99 },
      { paths: "services/**", patch_coverage_min: 99 },
    ]);
    expect(source).toContain('customProviderModule: "coverage-check/vitest"');
    expect(source).toContain("include: [...scope.include]");
    expect(source).toContain("exclude: [...scope.ignored]");
    expect(source).toContain("exclude: [...scope.ignored, ...scope.supplemental]");
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
