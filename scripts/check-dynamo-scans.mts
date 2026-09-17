import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SCAN_TABLE_NAMES } from "../services/cdk/src/foundation-data-access.ts";
import {
  DYNAMO_SCAN_MANIFEST,
  SCAN_GRANT_EXEMPT_FILES,
  type ScanManifestEntry,
} from "./dynamo-scan-manifest.ts";
import {
  fieldToTableMap,
  validateFieldCapitalization,
  type TableFieldMap,
} from "./dynamo-scan-field-map.mts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const servicesRoot = resolve(repoRoot, "services");

const EXCLUDED_DIRS = new Set(["node_modules", ".next", "dist", "coverage", "cdk.out", ".turbo"]);
const SCAN_CALL_PATTERN = /new ScanCommand\(/g;
const TABLE_NAME_PATTERN = /TableName:\s*([^,\n}) ]+)/;
const TABLE_NAME_SEARCH_WINDOW = 400;
const FIELD_EXPR_PATTERN = /^(?:ctx\.)?tables\.([A-Za-z0-9_]+)$/;
const KEY_SEPARATOR = "::";

export type ObservedSites = Record<string, Record<string, number>>;

/** Every `.ts`/`.tsx` source file under `root`, excluding tests, types, and build output. */
export function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

/**
 * Extract the `TableName:` expression for every `new ScanCommand(` call site in `content`, in
 * source order. `null` means a call site whose table could not be resolved within the search
 * window — the caller must treat that as a hard error, never a silent skip.
 */
export function extractScanTableExprs(content: string): Array<string | null> {
  const matches = [...content.matchAll(SCAN_CALL_PATTERN)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const nextStart = matches[index + 1]?.index ?? content.length;
    const windowEnd = Math.min(start + TABLE_NAME_SEARCH_WINDOW, nextStart);
    const captured = TABLE_NAME_PATTERN.exec(content.slice(start, windowEnd))?.[1];
    return captured ? captured.trim() : null;
  });
}

/** Group extracted table expressions per file into observed (file, tableExpr) -> count. */
export function buildObservedSites(files: readonly { relPath: string; content: string }[]): {
  observed: ObservedSites;
  unresolved: string[];
} {
  const observed: ObservedSites = {};
  const unresolved: string[] = [];
  for (const { relPath, content } of files) {
    extractScanTableExprs(content).forEach((expr, index) => {
      if (expr === null) {
        unresolved.push(
          `${relPath}: could not resolve TableName for ScanCommand call site #${index + 1}`,
        );
        return;
      }
      observed[relPath] ??= {};
      observed[relPath][expr] = (observed[relPath][expr] ?? 0) + 1;
    });
  }
  return { observed, unresolved };
}

function manifestKey(file: string, tableExpr: string): string {
  return `${file}${KEY_SEPARATOR}${tableExpr}`;
}

/**
 * Cross-check observed Scan call sites against the manifest in both directions, and verify
 * every production entry's tables are IAM-granted. Pure and dependency-injected so each
 * failure mode is a synthetic-input unit test (see check-dynamo-scans.test.ts).
 */
export function validateScanManifest(
  observed: ObservedSites,
  manifest: readonly ScanManifestEntry[],
  grantedTables: readonly string[],
  exemptFiles: readonly string[],
  fieldToTable: TableFieldMap,
): string[] {
  const errors: string[] = [];
  const byKey = new Map<string, ScanManifestEntry>();
  for (const entry of manifest) {
    const key = manifestKey(entry.file, entry.tableExpr);
    if (byKey.has(key)) {
      errors.push(`duplicate manifest entry for ${entry.file} (\`${entry.tableExpr}\`)`);
    }
    byKey.set(key, entry);
  }

  for (const [file, exprs] of Object.entries(observed)) {
    for (const [tableExpr, count] of Object.entries(exprs)) {
      const entry = byKey.get(manifestKey(file, tableExpr));
      if (!entry) {
        errors.push(
          `unlisted Scan: ${file} has ${count} ScanCommand call site(s) on \`${tableExpr}\` with no manifest entry`,
        );
      } else if (entry.count !== count) {
        errors.push(
          `manifest count mismatch for ${file} (\`${tableExpr}\`): manifest says ${entry.count}, source has ${count}`,
        );
      }
    }
  }

  for (const entry of manifest) {
    if ((observed[entry.file]?.[entry.tableExpr] ?? 0) === 0) {
      errors.push(
        `stale manifest entry: no ScanCommand call site found for ${entry.file} (\`${entry.tableExpr}\`)`,
      );
    }
    errors.push(...validateEntryGrant(entry, grantedTables, exemptFiles, fieldToTable));
  }
  return errors;
}

function validateEntryGrant(
  entry: ScanManifestEntry,
  grantedTables: readonly string[],
  exemptFiles: readonly string[],
  fieldToTable: TableFieldMap,
): string[] {
  const errors: string[] = [];
  if (!entry.runsUnderLambdaRole) {
    if (!exemptFiles.includes(entry.file)) {
      errors.push(
        `${entry.file} sets runsUnderLambdaRole: false but is not on the exempt-file allowlist ` +
          `(${exemptFiles.join(", ")}) — only those files may claim a Scan never runs under the Lambda role`,
      );
    }
    return errors;
  }
  for (const table of entry.tables) {
    if (!grantedTables.includes(table)) {
      errors.push(
        `missing IAM grant: ${entry.file} (\`${entry.tableExpr}\`) scans ${table}, which is not in SCAN_TABLE_NAMES`,
      );
    }
  }
  const fieldName = FIELD_EXPR_PATTERN.exec(entry.tableExpr)?.[1];
  if (fieldName) {
    const expected = fieldToTable[fieldName];
    if (!expected) {
      errors.push(`${entry.file}: unknown ctx.tables field \`${fieldName}\` in tableExpr`);
    } else if (entry.tables.length !== 1 || entry.tables[0] !== expected) {
      errors.push(
        `${entry.file} (\`${entry.tableExpr}\`): tables should be [${expected}] to match the ctx.tables field, got [${entry.tables.join(", ")}]`,
      );
    }
  }
  return errors;
}

function relativeToRepoRoot(absPath: string): string {
  return relative(repoRoot, absPath).split(sep).join("/");
}

function main(): void {
  const files = collectSourceFiles(servicesRoot).map((absPath) => ({
    relPath: relativeToRepoRoot(absPath),
    content: readFileSync(absPath, "utf8"),
  }));
  const { observed, unresolved } = buildObservedSites(files);
  const fieldToTable = fieldToTableMap();
  const errors = [
    ...unresolved,
    ...validateScanManifest(
      observed,
      DYNAMO_SCAN_MANIFEST,
      SCAN_TABLE_NAMES,
      SCAN_GRANT_EXEMPT_FILES,
      fieldToTable,
    ),
    ...validateFieldCapitalization(fieldToTable),
  ];
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const totalSites = Object.values(observed).reduce(
    (sum, exprs) => sum + Object.values(exprs).reduce((s, c) => s + c, 0),
    0,
  );
  console.log(
    `Dynamo Scan manifest verified: ${totalSites} call site(s) match ${DYNAMO_SCAN_MANIFEST.length} manifest entries, all IAM-granted where required.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
