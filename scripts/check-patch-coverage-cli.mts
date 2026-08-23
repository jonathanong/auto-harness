import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { checkPatchCoverage, formatPatchCoverageFailure } from "./check-patch-coverage.mts";

function defaultCoveragePaths(): string[] {
  const paths = [resolve("coverage", "lcov.info")];
  const supplementalDirectory = resolve("coverage", "patch");
  try {
    paths.push(
      ...readdirSync(supplementalDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".lcov"))
        .map((entry) => resolve(supplementalDirectory, entry.name))
        .toSorted(),
    );
  } catch {
    // Local aggregate-only coverage runs do not create supplemental reports.
  }
  return paths;
}

const [argumentBaseSha, ...argumentCoveragePaths] = process.argv.slice(2);
const baseSha = argumentBaseSha ?? process.env.COVERAGE_BASE_SHA;
if (!baseSha || baseSha.startsWith("-")) {
  throw new Error(
    "Usage: node scripts/check-patch-coverage-cli.mts <base-sha> [coverage/lcov.info ...]",
  );
}
const coveragePaths =
  argumentCoveragePaths.length > 0
    ? argumentCoveragePaths.map((path) => resolve(path))
    : defaultCoveragePaths();

let diff: string;
let lcov: string;
try {
  const git = spawnSync(
    "git", // NOSONAR -- shell is disabled and CI supplies a trusted, immutable PATH.
    ["-c", "core.quotepath=false", "diff", "--unified=0", "--no-ext-diff", baseSha, "--"],
    { encoding: "utf8" },
  );
  if (git.error) throw git.error;
  if (git.status !== 0) throw new Error(git.stderr || `git diff failed for base ${baseSha}`);
  diff = git.stdout;
  lcov = coveragePaths.map((coveragePath) => readFileSync(coveragePath, "utf8")).join("\n");
} catch (error) {
  throw new Error(
    `Unable to read patch or coverage report: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

const result = checkPatchCoverage(diff, lcov);
const failure = formatPatchCoverageFailure(result);
if (failure) throw new Error(failure);
console.log(
  `Patch line coverage passed: ${result.percentage.toFixed(2)}% (${result.covered}/${result.total}).`,
);
