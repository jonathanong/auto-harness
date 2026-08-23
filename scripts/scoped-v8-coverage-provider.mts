import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import v8CoverageModule from "@vitest/coverage-v8";
import { V8CoverageProvider } from "@vitest/coverage-v8/dist/provider.js";

import {
  coverageDisposition,
  executableLineNumbers,
  normalizeCoveragePath,
} from "./coverage-scope.mts";

export type SupplementalLineCoverage = {
  path: string;
  executableLines: Set<number>;
  hits: Record<string, number>;
};

export function formatSupplementalLcov(files: SupplementalLineCoverage[]): string {
  const records = files
    .toSorted((left, right) => left.path.localeCompare(right.path))
    .map(({ executableLines, hits, path }) => {
      const data = [...executableLines]
        .toSorted((left, right) => left - right)
        .map((line) => `DA:${line},${hits[String(line)] ?? 0}`);
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
      const source = readFileSync(file, "utf8");
      return [
        {
          executableLines: executableLineNumbers(source, path),
          hits: coverageMap.fileCoverageFor(file).getLineCoverage(),
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
