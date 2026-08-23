import { transformSync } from "esbuild";
import { eachMapping, TraceMap } from "@jridgewell/trace-mapping";
import { minimatch } from "minimatch";

export const COVERAGE_INCLUDE = [
  "modules/*/src/**/*.{ts,tsx}",
  "services/*/src/**/*.{ts,tsx}",
] as const;

const COMMON_EXCLUDES = [
  "**/*.test.{ts,tsx}",
  "**/*-test-helpers.{ts,tsx}",
  "**/*.d.ts",
  "**/dist/**",
  "**/.next/**",
  "**/next.config.ts",
  "**/tailwind.config.ts",
] as const;

const DELIBERATE_PATCH_EXCLUDES = [
  "services/{api,cdk}/src/cli.ts",
  "**/modules/ui/src/index.ts",
  "**/services/host-pane/src/index.ts",
] as const;

const AGGREGATE_ONLY_EXCLUDES = [
  "**/types.ts",
  "**/*-types.ts",
  "modules/shared/src/session.ts",
  "modules/shared/src/providers.ts",
  "**/db/plane-storage-auth.ts",
  "**/db/plane-storage-clear.ts",
  "**/db/plane-storage-deletion-markers.ts",
  "**/db/plane-storage-main-checkout-read.ts",
  "**/db/plane-storage-main-checkout-reconnect.ts",
  "**/db/plane-storage-main-checkout.ts",
  "**/db/plane-storage-provider-account-updates.ts",
  "**/db/plane-storage-provider-accounts.ts",
  "**/db/plane-storage-reconnect-rollback.ts",
  "**/db/plane-storage-reconnect.ts",
  "**/create-plane.ts",
  "**/services/web/src/lib/api.ts",
] as const;

export const PATCH_COVERAGE_EXCLUDE = [...COMMON_EXCLUDES, ...DELIBERATE_PATCH_EXCLUDES] as const;

export const AGGREGATE_COVERAGE_EXCLUDE = [
  ...PATCH_COVERAGE_EXCLUDE,
  ...AGGREGATE_ONLY_EXCLUDES,
] as const;

export type CoverageDisposition = "aggregate" | "supplemental" | "ignored";

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true }));
}

export function normalizeCoveragePath(value: string): string {
  return value
    .replace(/^file:\/\//, "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

export function coverageDisposition(value: string): CoverageDisposition {
  const path = normalizeCoveragePath(value);
  if (!matchesAny(path, COVERAGE_INCLUDE) || matchesAny(path, PATCH_COVERAGE_EXCLUDE)) {
    return "ignored";
  }
  return matchesAny(path, AGGREGATE_COVERAGE_EXCLUDE) ? "supplemental" : "aggregate";
}

/** Runtime-bearing source lines, derived from the JavaScript that esbuild emits. */
export function executableLineNumbers(source: string, path: string): Set<number> {
  const loader = path.endsWith(".tsx") ? "tsx" : "ts";
  const result = transformSync(source, {
    format: "esm",
    legalComments: "none",
    loader,
    sourcefile: normalizeCoveragePath(path),
    sourcemap: "external",
  });
  const lines = new Set<number>();
  eachMapping(new TraceMap(result.map), (mapping) => {
    if (mapping.originalLine !== null) lines.add(mapping.originalLine);
  });
  return lines;
}
