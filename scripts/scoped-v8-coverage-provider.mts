import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import v8CoverageModule from "@vitest/coverage-v8";
import { V8CoverageProvider } from "@vitest/coverage-v8/dist/provider.js";

import { coverageDisposition, normalizeCoveragePath } from "./coverage-scope.mts";

export type SupplementalLineCoverage = {
  path: string;
  hits: Record<string, number>;
};

type CoverageData = { fnMap: Record<string, { name: string }> };

export function isEmptyCoverageReport(data: CoverageData): boolean {
  return Object.values(data.fnMap).some(({ name }) => name === "(empty-report)");
}

export function formatSupplementalLcov(files: SupplementalLineCoverage[]): string {
  const records = files
    .toSorted((left, right) => left.path.localeCompare(right.path))
    .map(({ hits, path }) => {
      const data = Object.entries(hits)
        .map(([line, count]) => [Number(line), count] as const)
        .toSorted(([left], [right]) => left - right)
        .map(([line, count]) => `DA:${line},${count}`);
      return ["TN:", `SF:${normalizeCoveragePath(path)}`, ...data, "end_of_record"].join("\n");
    });
  return records.length === 0 ? "" : `${records.join("\n")}\n`;
}

class ScopedV8CoverageProvider extends V8CoverageProvider {
  override async generateCoverage(context: { allTestsRun: boolean }) {
    const coverageMap = await super.generateCoverage(context);
    const outputPath = process.env.VITEST_PATCH_COVERAGE_PATH;
    if (!outputPath) {
      throw new Error("VITEST_PATCH_COVERAGE_PATH is required by the scoped coverage provider.");
    }

    const supplemental = coverageMap.files().flatMap((file: string) => {
      const path = normalizeCoveragePath(relative(process.cwd(), file));
      if (coverageDisposition(path) !== "supplemental") return [];
      const fileCoverage = coverageMap.fileCoverageFor(file);
      if (isEmptyCoverageReport(fileCoverage.data)) return [];
      return [
        {
          hits: fileCoverage.getLineCoverage(),
          path,
        },
      ];
    });

    const resolvedOutput = resolve(outputPath);
    mkdirSync(dirname(resolvedOutput), { recursive: true });
    writeFileSync(resolvedOutput, formatSupplementalLcov(supplemental));
    coverageMap.filter((file: string) => {
      const path = normalizeCoveragePath(relative(process.cwd(), file));
      return coverageDisposition(path) === "aggregate";
    });
    return coverageMap;
  }
}

export default {
  ...v8CoverageModule,
  async getProvider(): Promise<ScopedV8CoverageProvider> {
    return new ScopedV8CoverageProvider();
  },
};
