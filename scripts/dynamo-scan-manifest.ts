import { PRODUCTION_SCAN_MANIFEST } from "./dynamo-scan-manifest-production.ts";
import { TEST_ONLY_SCAN_MANIFEST } from "./dynamo-scan-manifest-test-only.ts";

/**
 * Manifest of every intentional `ScanCommand` call site under `services/`.
 *
 * Verified in both directions by scripts/check-dynamo-scans.mts (wired into `pnpm check` and
 * CI as `pnpm check:dynamo-scans`):
 *  - every `new ScanCommand(` call site found in source must have a matching entry here (a
 *    new, unlisted Scan fails the check);
 *  - every entry must still match a real call site (a stale entry, with no source Scan left
 *    to justify it, fails the check);
 *  - every table an entry marks `runsUnderLambdaRole: true` for must be present in
 *    services/cdk/src/foundation-data-access.ts's `SCAN_TABLE_NAMES` — the exact grant PR
 *    #748 discovered missing for WorkspacePools/WorkspaceSlots/Integrations. See invariant 13
 *    (docs/plan.md#5-invariants, CLAUDE.md): Scan is allowed as a small, documented, capped
 *    catalog — this file is that catalog, not a ban.
 *
 * Entries live in dynamo-scan-manifest-production.ts and dynamo-scan-manifest-test-only.ts
 * (split to stay under oxlint's 200-line file cap). `runsUnderLambdaRole: false` is only
 * honored for files listed in `SCAN_GRANT_EXEMPT_FILES` (today just the DynamoDB-Local
 * test-cleanup helper) so a production Scan can't dodge the grant check by simply flipping
 * the flag — see check-dynamo-scans.mts's `validateScanManifest`.
 *
 * Two entries below (`plane-storage-catalog-providers.ts`'s `listCatalogTablePage` and
 * `plane-storage-clear.ts`'s `clearByKey`/`clearByKeys`) cover **parameterized** Scan helpers
 * whose table is a runtime argument, not a literal `ctx.tables.x`. Their `tables` lists used to
 * be hand-enumerated from their callers — a new caller passing an ungranted table wouldn't add
 * a new `new ScanCommand(` call site, so it stayed invisible to this manifest. That gap is now
 * closed at the type level: `listCatalogTablePage`'s table parameter is typed
 * `ScannableTableField` (services/api/src/db/dynamo.ts), a union derived from `SCAN_TABLE_NAMES`
 * itself, so passing an ungranted table is a `pnpm typecheck` error, not a manifest gap. Its
 * `tables` entry below is therefore `[...SCAN_TABLE_NAMES]` (exhaustive of what the type
 * permits, not just today's callers) rather than a hand list that could go stale.
 * `clearByKey`/`clearByKeys` are exempt from grants entirely (test-only), so the same technique
 * doesn't apply there; they're instead typed to `DynamoTableField` (any real table field), which
 * only rules out a typo'd or computed non-table string, not a specific ungranted-but-real table
 * — there's nothing to grant-check for an exempt file.
 */
export type ScanManifestEntry = {
  /** Path relative to the repo root. */
  file: string;
  /** Literal source text following `TableName:` at the call site(s). */
  tableExpr: string;
  /** How many `new ScanCommand(` call sites in `file` use exactly this `tableExpr`. */
  count: number;
  /** DynamoDB table logical names (as spelled in `SCAN_TABLE_NAMES`) this expression scans. */
  tables: readonly string[];
  /** False only for call sites proven to never run under the rest/websocket/cron role. */
  runsUnderLambdaRole: boolean;
  /** One-line reason this Scan exists. */
  why: string;
};

/** Files allowed to claim `runsUnderLambdaRole: false`. Keep this list short and named. */
export const SCAN_GRANT_EXEMPT_FILES = ["services/api/src/db/plane-storage-clear.ts"] as const;

export const DYNAMO_SCAN_MANIFEST: readonly ScanManifestEntry[] = [
  ...PRODUCTION_SCAN_MANIFEST,
  ...TEST_ONLY_SCAN_MANIFEST,
];
