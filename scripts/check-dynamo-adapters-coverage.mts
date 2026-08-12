import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const targetFiles = [
  "services/api/src/db/plane-storage-base.ts",
  "services/api/src/db/plane-storage-catalog.ts",
  "services/api/src/db/plane-storage-catalog-providers.ts",
  "services/api/src/db/plane-storage-locks.ts",
] as const;

const metricNames = ["lines", "branches", "functions", "statements"] as const;

type CoverageMetric = { pct: number; total: number };
type CoverageEntry = Partial<Record<(typeof metricNames)[number], CoverageMetric>>;
export type CoverageSummary = Record<string, CoverageEntry>;

export function validateDynamoAdapterCoverage(summary: CoverageSummary): string[] {
  const errors: string[] = [];
  for (const targetFile of targetFiles) {
    const entry = Object.entries(summary).find(([file]) => file.endsWith(targetFile))?.[1];
    if (!entry) {
      errors.push(`Coverage summary is missing ${targetFile}.`);
      continue;
    }
    for (const metricName of metricNames) {
      const metric = entry[metricName];
      if (!metric || metric.total === 0 || metric.pct !== 100) {
        errors.push(
          `${targetFile} ${metricName} coverage must be 100% (received ${metric?.pct ?? "missing"}%).`,
        );
      }
    }
  }
  return errors;
}

function runMarkerPath(): string {
  const workspaceKey = createHash("sha256").update(process.cwd()).digest("hex");
  return resolve(tmpdir(), `auto-harness-dynamo-coverage-${workspaceKey}.txt`);
}

function main(): void {
  const summaryPath = resolve("coverage", "coverage-summary.json");
  const markerPath = runMarkerPath();
  let marker: number;
  let summaryMtime: number;
  let summary: CoverageSummary;
  try {
    marker = Number(readFileSync(markerPath, "utf8"));
    summaryMtime = statSync(summaryPath).mtimeMs;
    summary = JSON.parse(readFileSync(summaryPath, "utf8")) as CoverageSummary;
  } catch {
    throw new Error(
      "Missing fresh coverage summary. Run pnpm test before verifying Dynamo adapter coverage.",
    );
  }
  if (!Number.isFinite(marker) || summaryMtime < marker) {
    throw new Error(
      "Coverage summary is stale. Run pnpm test before verifying Dynamo adapter coverage.",
    );
  }
  const errors = validateDynamoAdapterCoverage(summary);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  console.log("Dynamo adapter coverage is 100% for all four enforced files.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
