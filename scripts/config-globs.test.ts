import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const THRESHOLD_PATH_EXCEPTIONS = new Set([
  "services/host-daemon/src/cli.ts",
  "services/host-pane/src/lib/api.ts",
]);

const REQUIRED_EXCLUDES = [
  "**/*.test.{ts,tsx}",
  "**/*-test-helpers.{ts,tsx}",
  "**/*.d.ts",
  "**/types.ts",
  "**/*-types.ts",
  "services/{api,cdk}/src/cli.ts",
  "**/modules/ui/src/index.ts",
  "**/services/web/src/lib/api.ts",
  "**/services/host-pane/src/index.ts",
];

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
    expect(include).toEqual(["modules/*/src/**/*.{ts,tsx}", "services/*/src/**/*.{ts,tsx}"]);
    for (const pattern of include) {
      expect(pattern, `coverage.include must recurse with **: ${pattern}`).toContain("**");
    }

    const excludeBlock = coverage.match(/exclude:\s*\[([\s\S]*?)\],\s*\/\/ Vitest checks/)?.[1];
    expect(excludeBlock).toBeDefined();
    const exclude = quotedStrings(excludeBlock ?? "");
    for (const required of REQUIRED_EXCLUDES) {
      expect(exclude, `coverage.exclude missing ${required}`).toContain(required);
    }

    const thresholdKeys = [...coverage.matchAll(/^\s+"([^"]+)":/gm)].map((match) => match[1]);
    expect(thresholdKeys.length).toBeGreaterThan(0);
    for (const key of thresholdKeys) {
      if (THRESHOLD_PATH_EXCEPTIONS.has(key)) continue;
      expect(key, `coverage.thresholds path must recurse with **: ${key}`).toContain("**");
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
