import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { coverageDisposition, executableLineNumbers } from "./coverage-scope.mts";

export type LineNumbers = Set<number>;
export type DiffLines = Map<string, LineNumbers>;
export type LcovFile = { path: string; lines: Map<number, number> };
export type PatchLine = { path: string; line: number };
export type PatchCoverageResult = {
  total: number;
  covered: number;
  percentage: number;
  uncovered: PatchLine[];
  unmapped: PatchLine[];
  missingFiles: string[];
};
export type SourceReader = (path: string) => string;
const DEFAULT_THRESHOLD = 99;
function unquoteGitPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed;
  }
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
}
function pathFromDiffMarker(value: string): string | undefined {
  const path = unquoteGitPath(value.trim().split(/\t/, 1)[0] ?? "");
  if (path === "/dev/null") return undefined;
  return path.replace(/^[ab]\//, "");
}
function normalizePath(value: string): string {
  const withoutScheme = value.replace(/^file:\/\//, "");
  const normalized = withoutScheme.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.replace(/^[ab]\//, "");
}
function matchingLcovFiles(files: LcovFile[], diffPath: string): LcovFile[] {
  const normalized = normalizePath(diffPath);
  const absolute = normalizePath(resolve(diffPath));
  return files.filter((file) => {
    const candidate = normalizePath(file.path);
    return (
      candidate === normalized || candidate === absolute || candidate.endsWith(`/${normalized}`)
    );
  });
}
/** Parse added line numbers from zero-context git diff output. */
export function parseUnifiedDiff(diff: string): DiffLines {
  const result: DiffLines = new Map();
  let path: string | undefined;
  let newLine = 0;
  let remaining = 0;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      path = undefined;
      newLine = 0;
      remaining = 0;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const markerPath = pathFromDiffMarker(line.slice(4));
      if (markerPath) path = markerPath;
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      remaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    if (!path || remaining <= 0) continue;
    if (line.startsWith("+")) {
      const lines = result.get(path) ?? new Set<number>();
      lines.add(newLine);
      result.set(path, lines);
      newLine += 1;
      remaining -= 1;
    } else if (line.startsWith(" ")) {
      newLine += 1;
      remaining -= 1;
    }
  }
  return result;
}
/** Parse LCOV SF/DA records, retaining hit counts by source path and line. */
export function parseLcov(lcov: string): LcovFile[] {
  const files: LcovFile[] = [];
  let current: LcovFile | undefined;
  for (const line of lcov.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      current = { path: line.slice(3), lines: new Map() };
      files.push(current);
      continue;
    }
    if (!current || !line.startsWith("DA:")) continue;
    const [lineNumberText, hitCountText] = line.slice(3).split(",", 3);
    const lineNumber = Number(lineNumberText);
    const hitCount = Number(hitCountText);
    if (Number.isInteger(lineNumber) && lineNumber > 0 && Number.isFinite(hitCount)) {
      current.lines.set(lineNumber, Math.max(current.lines.get(lineNumber) ?? 0, hitCount));
    }
  }
  return files;
}

type FilePatchCoverage = Omit<PatchCoverageResult, "percentage">;

function emptyFilePatchCoverage(): FilePatchCoverage {
  return { total: 0, covered: 0, uncovered: [], unmapped: [], missingFiles: [] };
}

function mergedLineHits(files: LcovFile[]): Map<number, number> {
  const lineHits = new Map<number, number>();
  for (const file of files) {
    for (const [line, hits] of file.lines) {
      lineHits.set(line, Math.max(lineHits.get(line) ?? 0, hits));
    }
  }
  return lineHits;
}

function checkFilePatchCoverage(
  path: string,
  addedLines: LineNumbers,
  files: LcovFile[],
  readSource: SourceReader,
): FilePatchCoverage {
  if (coverageDisposition(path) === "ignored") return emptyFilePatchCoverage();
  const executableLines = executableLineNumbers(readSource(path), path);
  const changedLines = [...addedLines].filter((line) => executableLines.has(line));
  if (changedLines.length === 0) return emptyFilePatchCoverage();

  const matchingFiles = matchingLcovFiles(files, path);
  const lineHits = mergedLineHits(matchingFiles);
  const uncovered: PatchLine[] = [];
  const unmapped: PatchLine[] = [];
  let covered = 0;
  for (const line of changedLines) {
    if (!lineHits.has(line)) unmapped.push({ path, line });
    if ((lineHits.get(line) ?? 0) > 0) covered += 1;
    else uncovered.push({ path, line });
  }
  return {
    total: changedLines.length,
    covered,
    uncovered,
    unmapped,
    missingFiles: matchingFiles.length === 0 ? [path] : [],
  };
}

export function checkPatchCoverage(
  diff: string | DiffLines,
  lcov: string | LcovFile[],
  threshold = DEFAULT_THRESHOLD,
  readSource: SourceReader = (path) => readFileSync(resolve(path), "utf8"),
): PatchCoverageResult {
  const addedLines = typeof diff === "string" ? parseUnifiedDiff(diff) : diff;
  const files = typeof lcov === "string" ? parseLcov(lcov) : lcov;
  const uncovered: PatchLine[] = [];
  const unmapped: PatchLine[] = [];
  const missingFiles: string[] = [];
  let total = 0;
  let covered = 0;

  for (const [path, lines] of addedLines) {
    const result = checkFilePatchCoverage(path, lines, files, readSource);
    total += result.total;
    covered += result.covered;
    uncovered.push(...result.uncovered);
    unmapped.push(...result.unmapped);
    missingFiles.push(...result.missingFiles);
  }

  const percentage = total === 0 ? 100 : (covered / total) * 100;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error(`Coverage threshold must be between 0 and 100 (received ${threshold}).`);
  }
  return { total, covered, percentage, uncovered, unmapped, missingFiles };
}
export function formatPatchCoverageFailure(
  result: PatchCoverageResult,
  threshold = DEFAULT_THRESHOLD,
): string | undefined {
  if (result.percentage >= threshold && result.missingFiles.length === 0) return undefined;
  const lines = [
    `Patch line coverage is ${result.percentage.toFixed(2)}% (${result.covered}/${result.total}); required ${threshold}%.`,
  ];
  if (result.missingFiles.length > 0) {
    lines.push(`Changed executable files missing from LCOV: ${result.missingFiles.join(", ")}`);
  }
  if (result.uncovered.length > 0) {
    lines.push(
      `Uncovered added lines: ${result.uncovered.map(({ path, line }) => `${path}:${line}`).join(", ")}`,
    );
  }
  if (result.unmapped.length > 0) {
    lines.push(
      `Added lines missing from LCOV: ${result.unmapped.map(({ path, line }) => `${path}:${line}`).join(", ")}`,
    );
  }
  return lines.join("\n");
}
