import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildObservedSites,
  collectSourceFiles,
  extractScanTableExprs,
  validateScanManifest,
  type ObservedSites,
} from "./check-dynamo-scans.mts";
import { DYNAMO_SCAN_MANIFEST, SCAN_GRANT_EXEMPT_FILES } from "./dynamo-scan-manifest.ts";
import { fieldToTableMap } from "./dynamo-scan-field-map.mts";
import { SCAN_TABLE_NAMES } from "../services/cdk/src/foundation-data-access.ts";

describe("extractScanTableExprs", () => {
  it("resolves TableName across the real call-site shapes", () => {
    expect(
      extractScanTableExprs("new ScanCommand({ TableName: ctx.tables.rateLimits, X: 1 }),"),
    ).toEqual(["ctx.tables.rateLimits"]);
    expect(
      extractScanTableExprs(
        "new ScanCommand({\n  ConsistentRead: true,\n  TableName: ctx.tables.repositories,\n}),",
      ),
    ).toEqual(["ctx.tables.repositories"]);
    expect(
      extractScanTableExprs(": new ScanCommand({\n  TableName: ctx.tables.worktrees,\n}),"),
    ).toEqual(["ctx.tables.worktrees"]);
    expect(
      extractScanTableExprs("new ScanCommand({\n  TableName: tableName,\n  Limit: 1,\n}),"),
    ).toEqual(["tableName"]);
  });

  it("resolves each call site independently and never crosses into the next one", () => {
    const content =
      "new ScanCommand({ TableName: ctx.tables.a }),\nnew ScanCommand({ TableName: ctx.tables.b }),";
    expect(extractScanTableExprs(content)).toEqual(["ctx.tables.a", "ctx.tables.b"]);
  });

  it("returns null (never silently skips) when TableName cannot be found", () => {
    expect(extractScanTableExprs("new ScanCommand({ ConsistentRead: true }),")).toEqual([null]);
  });
});

describe("buildObservedSites", () => {
  it("groups per-file table-expression counts and surfaces unresolved sites", () => {
    const { observed, unresolved } = buildObservedSites([
      {
        relPath: "a.ts",
        content:
          "new ScanCommand({ TableName: ctx.tables.x }),\nnew ScanCommand({ TableName: ctx.tables.x }),",
      },
      { relPath: "b.ts", content: "new ScanCommand({ Foo: 1 })," },
    ]);
    expect(observed).toEqual({ "a.ts": { "ctx.tables.x": 2 } });
    expect(unresolved).toEqual(["b.ts: could not resolve TableName for ScanCommand call site #1"]);
  });
});

describe("collectSourceFiles", () => {
  it("finds .ts files while pruning node_modules/build output and excluding tests/types", () => {
    const root = mkdtempSync(join(tmpdir(), "dynamo-scan-manifest-test-"));
    try {
      mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(root, "node_modules", "pkg", "index.ts"), "// ignored");
      mkdirSync(join(root, "db"), { recursive: true });
      writeFileSync(join(root, "db", "real.ts"), "export {};");
      writeFileSync(join(root, "db", "real.test.ts"), "export {};");
      writeFileSync(join(root, "db", "types.d.ts"), "export {};");
      writeFileSync(join(root, "db", "widget.tsx"), "export {};");
      expect(collectSourceFiles(root).toSorted()).toEqual(
        [join(root, "db", "real.ts"), join(root, "db", "widget.tsx")].toSorted(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const fields = fieldToTableMap();

function entry(overrides: Partial<(typeof DYNAMO_SCAN_MANIFEST)[number]> = {}) {
  return {
    file: "services/api/src/db/example.ts",
    tableExpr: "ctx.tables.schedules",
    count: 1,
    tables: ["Schedules"] as readonly string[],
    runsUnderLambdaRole: true,
    why: "example",
    ...overrides,
  };
}

describe("validateScanManifest", () => {
  it("accepts a manifest that exactly matches observed sites and has every grant", () => {
    const observed: ObservedSites = {
      "services/api/src/db/example.ts": { "ctx.tables.schedules": 1 },
    };
    expect(validateScanManifest(observed, [entry()], ["Schedules"], [], fields)).toEqual([]);
  });

  it("rejects two manifest entries claiming the same file and tableExpr", () => {
    const observed: ObservedSites = {
      "services/api/src/db/example.ts": { "ctx.tables.schedules": 1 },
    };
    expect(validateScanManifest(observed, [entry(), entry()], ["Schedules"], [], fields)).toEqual(
      expect.arrayContaining([
        "duplicate manifest entry for services/api/src/db/example.ts (`ctx.tables.schedules`)",
      ]),
    );
  });

  it("isolates each failure mode: unlisted, count mismatch, stale, missing grant, unguarded exemption, field mismatch", () => {
    const observed: ObservedSites = {
      "services/api/src/db/example.ts": { "ctx.tables.schedules": 2 }, // manifest below says 1
      "services/api/src/db/unlisted.ts": { "ctx.tables.users": 1 }, // no manifest entry at all
      "services/api/src/db/ungranted.ts": { hostLocksTableName: 1 },
      "services/api/src/db/exempt-abuse.ts": { "ctx.tables.schedules": 1 },
      "services/api/src/db/mismatch.ts": { "ctx.tables.users": 1 },
    };
    const manifest = [
      entry(), // count mismatch
      entry({
        file: "services/api/src/db/gone.ts",
        tableExpr: "goneTableName",
        tables: ["Schedules"],
      }), // stale
      entry({
        file: "services/api/src/db/ungranted.ts",
        tableExpr: "hostLocksTableName",
        tables: ["HostLocks"],
      }), // missing grant
      entry({ file: "services/api/src/db/exempt-abuse.ts", runsUnderLambdaRole: false }), // unguarded exemption
      entry({
        file: "services/api/src/db/mismatch.ts",
        tableExpr: "ctx.tables.users",
        tables: ["Schedules"],
      }), // field mismatch: ctx.tables.users should resolve to [Users]
    ];
    const errors = validateScanManifest(observed, manifest, ["Schedules"], [], fields);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unlisted Scan: services/api/src/db/unlisted.ts"),
        expect.stringContaining("manifest count mismatch for services/api/src/db/example.ts"),
        expect.stringContaining("stale manifest entry"),
        expect.stringContaining("missing IAM grant: services/api/src/db/ungranted.ts"),
        expect.stringContaining("exempt-abuse.ts sets runsUnderLambdaRole: false"),
        expect.stringContaining("tables should be [Users]"),
      ]),
    );
  });

  it("only honors runsUnderLambdaRole: false for files on the exempt allowlist", () => {
    const observed: ObservedSites = { "allowed.ts": { x: 1 } };
    const testEntry = entry({
      file: "allowed.ts",
      tableExpr: "x",
      tables: [],
      runsUnderLambdaRole: false,
    });
    expect(validateScanManifest(observed, [testEntry], [], ["allowed.ts"], fields)).toEqual([]);
    expect(validateScanManifest(observed, [testEntry], [], [], fields)).toEqual(
      expect.arrayContaining([expect.stringContaining("not on the exempt-file allowlist")]),
    );
  });
});

describe("the real Dynamo Scan manifest", () => {
  it("matches every real ScanCommand call site under services/ with an IAM-verified entry", () => {
    const servicesRoot = fileURLToPath(new URL("../services", import.meta.url));
    const files = collectSourceFiles(servicesRoot).map((absPath) => ({
      relPath: `services/${absPath.slice(servicesRoot.length + 1)}`,
      content: readFileSync(absPath, "utf8"),
    }));
    const { observed, unresolved } = buildObservedSites(files);
    expect(unresolved).toEqual([]);
    expect(
      validateScanManifest(
        observed,
        DYNAMO_SCAN_MANIFEST,
        SCAN_TABLE_NAMES,
        SCAN_GRANT_EXEMPT_FILES,
        fieldToTableMap(),
      ),
    ).toEqual([]);
  });
});
